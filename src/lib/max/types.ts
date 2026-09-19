export const MAX_STATES = [
  "DISABLED",
  "SLEEP",
  "WAKING",
  "ACTIVE",
  "THINKING",
  "EXECUTING",
  "SPEAKING",
  "INTERRUPTED",
] as const;

export type MaxState = (typeof MAX_STATES)[number];

export type PermissionTier = 1 | 2 | 3;

export type DevicePlatform = "windows" | "android" | "web";

export type MaxIntentType =
  | "WAKE"
  | "SLEEP"
  | "DISABLE"
  | "ENABLE"
  | "INTERRUPT"
  | "OPEN_APPLICATION"
  | "CLOSE_APPLICATION"
  | "OPEN_URL"
  | "OPEN_FOLDER"
  | "OPEN_FILE"
  | "SET_VOLUME"
  | "TAKE_SCREENSHOT"
  | "DELETE_SANDBOX_FILE"
  | "UNKNOWN";

export type ParsedIntent = {
  type: MaxIntentType;
  confidence: number;
  language: "english" | "mixed" | "unknown";
  targetDeviceHint?: "laptop" | "phone";
  entities: Record<string, string | number | boolean>;
};

export type ActionProposal = {
  tool: string;
  args: Record<string, unknown>;
  permissionTier: PermissionTier;
  requiresConfirmation: boolean;
  confirmationPhrase?: string;
};

export type MaxExecutionResult = {
  success: boolean;
  action: string;
  device: string;
  result?: string;
  error?: string;
  mode: "simulated-control-plane";
};

export type CommandResponse = {
  sessionId: number;
  stateBefore: MaxState;
  stateAfter: MaxState;
  transcript: string;
  intent: ParsedIntent;
  action: ActionProposal | null;
  execution: MaxExecutionResult | null;
  assistantReply: string;
  latencyMs: number;
};

export const WAKE_PHRASES = ["max", "wake up", "wake up, daddy's home"];

export const CAPABILITY_CATALOG: Record<DevicePlatform, string[]> = {
  windows: [
    "open_app",
    "close_app",
    "open_url",
    "open_folder",
    "open_file",
    "set_volume",
    "take_screenshot",
    "delete_sandbox_file",
  ],
  android: ["open_app", "set_volume", "take_screenshot"],
  web: ["search_web"],
};
