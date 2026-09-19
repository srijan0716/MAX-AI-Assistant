import { boolean, integer, jsonb, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const maxDevices = pgTable("max_devices", {
  id: serial("id").primaryKey(),
  deviceKey: varchar("device_key", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  platform: varchar("platform", { length: 32 }).notNull(),
  isOnline: boolean("is_online").notNull().default(true),
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const maxSessions = pgTable("max_sessions", {
  id: serial("id").primaryKey(),
  state: varchar("state", { length: 32 }).notNull().default("SLEEP"),
  sourceDeviceKey: varchar("source_device_key", { length: 64 }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const maxCommandLogs = pgTable("max_command_logs", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => maxSessions.id, { onDelete: "cascade" }),
  sourceDeviceKey: varchar("source_device_key", { length: 64 }).notNull(),
  targetDeviceKey: varchar("target_device_key", { length: 64 }).notNull(),
  transcript: text("transcript").notNull(),
  detectedLanguage: varchar("detected_language", { length: 32 }).notNull().default("unknown"),
  normalizedIntent: jsonb("normalized_intent").$type<Record<string, unknown>>().notNull().default({}),
  proposedTool: varchar("proposed_tool", { length: 64 }),
  toolArgs: jsonb("tool_args").$type<Record<string, unknown>>().notNull().default({}),
  permissionTier: integer("permission_tier").notNull().default(1),
  confirmationRequired: boolean("confirmation_required").notNull().default(false),
  confirmationPhrase: varchar("confirmation_phrase", { length: 128 }),
  stateBefore: varchar("state_before", { length: 32 }).notNull(),
  stateAfter: varchar("state_after", { length: 32 }).notNull(),
  success: boolean("success").notNull(),
  resultMessage: text("result_message").notNull(),
  errorMessage: text("error_message"),
  latencyMs: integer("latency_ms").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const maxMemory = pgTable("max_memory", {
  id: serial("id").primaryKey(),
  scope: varchar("scope", { length: 32 }).notNull(),
  memoryKey: varchar("memory_key", { length: 120 }).notNull(),
  memoryValue: jsonb("memory_value").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const maxPendingConfirmations = pgTable("max_pending_confirmations", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id")
    .notNull()
    .references(() => maxSessions.id, { onDelete: "cascade" }),
  confirmationPhrase: varchar("confirmation_phrase", { length: 128 }).notNull(),
  actionPayload: jsonb("action_payload").$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
