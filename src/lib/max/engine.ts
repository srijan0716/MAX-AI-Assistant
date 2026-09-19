import { db } from "@/db";
import {
  maxCommandLogs,
  maxDevices,
  maxMemory,
  maxPendingConfirmations,
  maxSessions,
} from "@/db/schema";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { parseIntent } from "@/lib/max/parser";
import { MAX_SANDBOX_ROOT, normalizeSandboxPath, toConfirmationPhraseForDelete } from "@/lib/max/safety";
import type {
  ActionProposal,
  CommandResponse,
  DevicePlatform,
  MaxExecutionResult,
  MaxIntentType,
  MaxState,
  ParsedIntent,
} from "@/lib/max/types";
import { CAPABILITY_CATALOG } from "@/lib/max/types";

const NOW_PLUS_60_SECONDS_SQL = sql`now() + interval '60 seconds'`;

const SESSION_MEMORY_SCOPE = "session";

type SessionRow = typeof maxSessions.$inferSelect;
type DeviceRow = typeof maxDevices.$inferSelect;

type PendingActionPayload = {
  tool: string;
  args: Record<string, unknown>;
  permissionTier: 1 | 2 | 3;
  targetDeviceKey: string;
};

export async function ensureMaxSchema() {
  await db.execute(sql`
    create table if not exists max_devices (
      id serial primary key,
      device_key varchar(64) unique not null,
      name varchar(120) not null,
      platform varchar(32) not null,
      is_online boolean not null default true,
      capabilities jsonb not null default '[]'::jsonb,
      last_seen_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    )
  `);

  await db.execute(sql`
    create table if not exists max_sessions (
      id serial primary key,
      state varchar(32) not null default 'SLEEP',
      source_device_key varchar(64) not null,
      started_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  await db.execute(sql`
    create table if not exists max_command_logs (
      id serial primary key,
      session_id integer not null references max_sessions(id) on delete cascade,
      source_device_key varchar(64) not null,
      target_device_key varchar(64) not null,
      transcript text not null,
      detected_language varchar(32) not null default 'unknown',
      normalized_intent jsonb not null default '{}'::jsonb,
      proposed_tool varchar(64),
      tool_args jsonb not null default '{}'::jsonb,
      permission_tier integer not null default 1,
      confirmation_required boolean not null default false,
      confirmation_phrase varchar(128),
      state_before varchar(32) not null,
      state_after varchar(32) not null,
      success boolean not null,
      result_message text not null,
      error_message text,
      latency_ms integer not null default 0,
      created_at timestamptz not null default now()
    )
  `);

  await db.execute(sql`
    create table if not exists max_memory (
      id serial primary key,
      scope varchar(32) not null,
      memory_key varchar(120) not null,
      memory_value jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  await db.execute(sql`
    create table if not exists max_pending_confirmations (
      id serial primary key,
      session_id integer not null references max_sessions(id) on delete cascade,
      confirmation_phrase varchar(128) not null,
      action_payload jsonb not null default '{}'::jsonb,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `);
}

export async function seedDevicesIfNeeded() {
  const existing = await db.select().from(maxDevices).limit(1);
  if (existing.length > 0) return;

  await db.insert(maxDevices).values([
    {
      deviceKey: "laptop-main",
      name: "Laptop",
      platform: "windows",
      isOnline: true,
      capabilities: CAPABILITY_CATALOG.windows,
    },
    {
      deviceKey: "phone-main",
      name: "Phone",
      platform: "android",
      isOnline: true,
      capabilities: CAPABILITY_CATALOG.android,
    },
  ]);
}

async function getDeviceByKey(deviceKey: string) {
  const rows = await db.select().from(maxDevices).where(eq(maxDevices.deviceKey, deviceKey)).limit(1);
  return rows[0] ?? null;
}

async function getOrCreateSession(sessionId: number | undefined, sourceDeviceKey: string): Promise<SessionRow> {
  if (sessionId) {
    const existing = await db.select().from(maxSessions).where(eq(maxSessions.id, sessionId)).limit(1);
    if (existing[0]) return existing[0];
  }

  const inserted = await db
    .insert(maxSessions)
    .values({ state: "SLEEP", sourceDeviceKey })
    .returning();

  return inserted[0];
}

function getNextState(current: MaxState, intentType: MaxIntentType): MaxState {
  if (intentType === "DISABLE") return "DISABLED";
  if (intentType === "SLEEP") return "SLEEP";
  if (intentType === "WAKE" || intentType === "ENABLE") return "ACTIVE";
  if (intentType === "INTERRUPT") return "INTERRUPTED";

  if (current === "DISABLED") return "DISABLED";
  if (current === "SLEEP") return "SLEEP";

  return "ACTIVE";
}

function routeTargetDevice(parsedIntent: ParsedIntent, sourceDevice: DeviceRow): string {
  if (parsedIntent.targetDeviceHint === "laptop") return "laptop-main";
  if (parsedIntent.targetDeviceHint === "phone") return "phone-main";
  return sourceDevice.deviceKey;
}

function mapIntentToAction(intent: ParsedIntent): ActionProposal | null {
  switch (intent.type) {
    case "OPEN_APPLICATION":
      return {
        tool: "open_app",
        args: { application: intent.entities.application ?? "unknown" },
        permissionTier: 1,
        requiresConfirmation: false,
      };
    case "CLOSE_APPLICATION":
      return {
        tool: "close_app",
        args: { application: intent.entities.application ?? "unknown" },
        permissionTier: 2,
        requiresConfirmation: false,
      };
    case "OPEN_URL":
      return {
        tool: "open_url",
        args: { url: intent.entities.url ?? "https://example.com" },
        permissionTier: 1,
        requiresConfirmation: false,
      };
    case "OPEN_FOLDER":
      return {
        tool: "open_folder",
        args: { path: intent.entities.path ?? "C:\\" },
        permissionTier: 1,
        requiresConfirmation: false,
      };
    case "OPEN_FILE":
      return {
        tool: "open_file",
        args: { path: intent.entities.path ?? "" },
        permissionTier: 1,
        requiresConfirmation: false,
      };
    case "SET_VOLUME":
      return {
        tool: "set_volume",
        args: { level: intent.entities.level ?? 50 },
        permissionTier: 2,
        requiresConfirmation: false,
      };
    case "TAKE_SCREENSHOT":
      return {
        tool: "take_screenshot",
        args: {},
        permissionTier: 1,
        requiresConfirmation: false,
      };
    case "DELETE_SANDBOX_FILE": {
      const filePath = String(intent.entities.filePath ?? "");
      return {
        tool: "delete_sandbox_file",
        args: { filePath },
        permissionTier: 3,
        requiresConfirmation: true,
        confirmationPhrase: toConfirmationPhraseForDelete(filePath),
      };
    }
    default:
      return null;
  }
}

function capabilitySupported(platform: DevicePlatform, tool: string): boolean {
  return CAPABILITY_CATALOG[platform]?.includes(tool) ?? false;
}

function simulatedExecute(action: ActionProposal, targetDevice: DeviceRow): MaxExecutionResult {
  return {
    success: true,
    action: action.tool,
    device: targetDevice.deviceKey,
    result: `Action '${action.tool}' accepted by ${targetDevice.platform} adapter in simulated mode.`,
    mode: "simulated-control-plane",
  };
}

async function logCommand(input: {
  sessionId: number;
  sourceDeviceKey: string;
  targetDeviceKey: string;
  transcript: string;
  detectedLanguage: string;
  intent: ParsedIntent;
  action: ActionProposal | null;
  stateBefore: MaxState;
  stateAfter: MaxState;
  success: boolean;
  resultMessage: string;
  errorMessage?: string;
  latencyMs: number;
}) {
  await db.insert(maxCommandLogs).values({
    sessionId: input.sessionId,
    sourceDeviceKey: input.sourceDeviceKey,
    targetDeviceKey: input.targetDeviceKey,
    transcript: input.transcript,
    detectedLanguage: input.detectedLanguage,
    normalizedIntent: input.intent,
    proposedTool: input.action?.tool,
    toolArgs: input.action?.args ?? {},
    permissionTier: input.action?.permissionTier ?? 1,
    confirmationRequired: input.action?.requiresConfirmation ?? false,
    confirmationPhrase: input.action?.confirmationPhrase,
    stateBefore: input.stateBefore,
    stateAfter: input.stateAfter,
    success: input.success,
    resultMessage: input.resultMessage,
    errorMessage: input.errorMessage,
    latencyMs: input.latencyMs,
  });
}

async function upsertSessionMemory(sessionId: number, key: string, value: Record<string, unknown>) {
  const memoryKey = `session:${sessionId}:${key}`;
  const existing = await db
    .select()
    .from(maxMemory)
    .where(and(eq(maxMemory.scope, SESSION_MEMORY_SCOPE), eq(maxMemory.memoryKey, memoryKey)))
    .limit(1);

  if (existing[0]) {
    await db
      .update(maxMemory)
      .set({ memoryValue: value, updatedAt: new Date() })
      .where(eq(maxMemory.id, existing[0].id));
    return;
  }

  await db.insert(maxMemory).values({
    scope: SESSION_MEMORY_SCOPE,
    memoryKey,
    memoryValue: value,
  });
}

async function handlePendingConfirmation(
  sessionId: number,
  transcriptLower: string,
): Promise<{ action: PendingActionPayload | null; consumed: boolean }> {
  const pending = await db
    .select()
    .from(maxPendingConfirmations)
    .where(and(eq(maxPendingConfirmations.sessionId, sessionId), gt(maxPendingConfirmations.expiresAt, new Date())))
    .orderBy(desc(maxPendingConfirmations.id))
    .limit(1);

  const latest = pending[0];
  if (!latest) return { action: null, consumed: false };

  if (transcriptLower.trim() !== latest.confirmationPhrase.toLowerCase()) {
    return { action: null, consumed: false };
  }

  await db.delete(maxPendingConfirmations).where(eq(maxPendingConfirmations.id, latest.id));

  return {
    action: latest.actionPayload as PendingActionPayload,
    consumed: true,
  };
}

async function savePendingConfirmation(sessionId: number, action: PendingActionPayload, phrase: string) {
  await db.insert(maxPendingConfirmations).values({
    sessionId,
    confirmationPhrase: phrase,
    actionPayload: action,
    expiresAt: NOW_PLUS_60_SECONDS_SQL,
  });
}

export async function getOverview() {
  await ensureMaxSchema();
  await seedDevicesIfNeeded();

  const devices = await db.select().from(maxDevices).orderBy(desc(maxDevices.id));
  const sessions = await db.select().from(maxSessions).orderBy(desc(maxSessions.id)).limit(5);
  const logs = await db.select().from(maxCommandLogs).orderBy(desc(maxCommandLogs.id)).limit(20);

  return {
    identity: {
      name: "MAX",
      mission: "Personal AI operating layer with deterministic orchestration",
      executionMode: "simulated-control-plane",
      safety: {
        confirmationModel: "tiered + phrase-specific",
        sandboxRoot: MAX_SANDBOX_ROOT,
        llmExecutionPolicy: "LLM may propose actions, deterministic engine validates and executes",
      },
    },
    phases: [
      "v0.1 Windows vertical slice",
      "Windows automation expansion",
      "Android agent",
      "Cross-device routing",
      "Multilingual hardening",
      "Online/offline model router",
    ],
    devices,
    sessions,
    recentLogs: logs,
  };
}

export async function processCommand(input: {
  transcript: string;
  sourceDeviceKey?: string;
  sessionId?: number;
}): Promise<CommandResponse> {
  const start = Date.now();
  await ensureMaxSchema();
  await seedDevicesIfNeeded();

  const transcript = input.transcript.trim();
  const sourceDeviceKey = input.sourceDeviceKey ?? "laptop-main";

  const sourceDevice = await getDeviceByKey(sourceDeviceKey);
  if (!sourceDevice) {
    throw new Error(`Unknown source device '${sourceDeviceKey}'`);
  }

  const session = await getOrCreateSession(input.sessionId, sourceDeviceKey);
  const stateBefore = session.state as MaxState;
  const lower = transcript.toLowerCase();

  const pending = await handlePendingConfirmation(session.id, lower);

  if (pending.consumed && pending.action) {
    const targetDevice = await getDeviceByKey(pending.action.targetDeviceKey);
    const action: ActionProposal = {
      tool: pending.action.tool,
      args: pending.action.args,
      permissionTier: pending.action.permissionTier,
      requiresConfirmation: false,
    };

    const execution = targetDevice
      ? simulatedExecute(action, targetDevice)
      : {
          success: false,
          action: action.tool,
          device: pending.action.targetDeviceKey,
          error: "Target device not found",
          mode: "simulated-control-plane" as const,
        };

    const stateAfter: MaxState = "ACTIVE";
    await db.update(maxSessions).set({ state: stateAfter, updatedAt: new Date() }).where(eq(maxSessions.id, session.id));

    const latencyMs = Date.now() - start;
    const reply = execution.success ? "Deleted." : execution.error ?? "Delete failed.";

    await logCommand({
      sessionId: session.id,
      sourceDeviceKey,
      targetDeviceKey: pending.action.targetDeviceKey,
      transcript,
      detectedLanguage: "english",
      intent: {
        type: "DELETE_SANDBOX_FILE",
        confidence: 1,
        language: "english",
        entities: action.args as Record<string, string | number | boolean>,
      },
      action,
      stateBefore,
      stateAfter,
      success: execution.success,
      resultMessage: reply,
      errorMessage: execution.error,
      latencyMs,
    });

    return {
      sessionId: session.id,
      stateBefore,
      stateAfter,
      transcript,
      intent: {
        type: "DELETE_SANDBOX_FILE",
        confidence: 1,
        language: "english",
        entities: action.args as Record<string, string | number | boolean>,
      },
      action,
      execution,
      assistantReply: reply,
      latencyMs,
    };
  }

  const intent = parseIntent(transcript);
  const targetDeviceKey = routeTargetDevice(intent, sourceDevice);
  const targetDevice = await getDeviceByKey(targetDeviceKey);

  let stateAfter = getNextState(stateBefore, intent.type);
  let action = mapIntentToAction(intent);
  let execution: MaxExecutionResult | null = null;
  let assistantReply = "I did not understand that command yet.";
  let success = false;
  let errorMessage: string | undefined;

  if (stateBefore === "DISABLED" && !["ENABLE", "WAKE"].includes(intent.type)) {
    assistantReply = "MAX is disabled. Say 'enable MAX' to resume listening.";
    success = false;
    action = null;
    stateAfter = "DISABLED";
  } else if (stateBefore === "SLEEP" && intent.type !== "WAKE") {
    assistantReply = "MAX is sleeping. Say 'MAX' or 'wake up' first.";
    success = false;
    action = null;
    stateAfter = "SLEEP";
  } else if (intent.type === "WAKE") {
    assistantReply = "I'm awake.";
    success = true;
    action = null;
    stateAfter = "ACTIVE";
  } else if (intent.type === "SLEEP") {
    assistantReply = "Going to sleep.";
    success = true;
    action = null;
  } else if (intent.type === "DISABLE") {
    assistantReply = "MAX is now disabled until manually re-enabled.";
    success = true;
    action = null;
  } else if (intent.type === "ENABLE") {
    assistantReply = "MAX has been re-enabled and is active.";
    success = true;
    action = null;
    stateAfter = "ACTIVE";
  } else if (intent.type === "INTERRUPT") {
    assistantReply = "Interrupted. Returning to active state.";
    success = true;
    action = null;
    stateAfter = "ACTIVE";
  } else if (!action) {
    assistantReply = "Command recognized as unsupported for v0.1.";
    success = false;
  } else if (!targetDevice) {
    assistantReply = "Target device is unavailable.";
    success = false;
    errorMessage = "Target device not found";
  } else if (!capabilitySupported(targetDevice.platform as DevicePlatform, action.tool)) {
    assistantReply = `${targetDevice.name} does not support '${action.tool}' yet.`;
    success = false;
    errorMessage = "Capability unavailable";
  } else if (action.tool === "delete_sandbox_file") {
    const rawPath = String(action.args.filePath ?? "");
    const normalized = normalizeSandboxPath(rawPath);
    if (!normalized.ok) {
      assistantReply = normalized.reason;
      success = false;
      errorMessage = normalized.reason;
    } else {
      action.args.filePath = normalized.fullPath;

      const confirmationPhrase = action.confirmationPhrase ?? "confirm delete";
      await savePendingConfirmation(
        session.id,
        {
          tool: action.tool,
          args: action.args,
          permissionTier: action.permissionTier,
          targetDeviceKey,
        },
        confirmationPhrase,
      );

      assistantReply = `This will permanently delete ${normalized.fullPath}. Say '${confirmationPhrase}' to continue.`;
      success = true;
      execution = null;
    }
  } else {
    execution = simulatedExecute(action, targetDevice);
    success = execution.success;
    assistantReply = execution.success
      ? `${action.tool} executed on ${targetDevice.name}.`
      : execution.error ?? "Execution failed.";
  }

  await db.update(maxSessions).set({ state: stateAfter, updatedAt: new Date() }).where(eq(maxSessions.id, session.id));

  await upsertSessionMemory(session.id, "last_command", {
    transcript,
    intent: intent.type,
    targetDeviceKey,
    ts: new Date().toISOString(),
  });

  const latencyMs = Date.now() - start;

  await logCommand({
    sessionId: session.id,
    sourceDeviceKey,
    targetDeviceKey,
    transcript,
    detectedLanguage: intent.language,
    intent,
    action,
    stateBefore,
    stateAfter,
    success,
    resultMessage: assistantReply,
    errorMessage,
    latencyMs,
  });

  return {
    sessionId: session.id,
    stateBefore,
    stateAfter,
    transcript,
    intent,
    action,
    execution,
    assistantReply,
    latencyMs,
  };
}
