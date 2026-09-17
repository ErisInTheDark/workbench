/*
 * Exports:
 * - voiceSettings/voiceProfileLink: typed global voice fallback and optional profile link.
 * - voiceSettingsSchemaHistory: additive voice selection schema.
 */
import { defineTable, enumText, integer, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const settings = defineTable("workbench_voice_settings", {
  id: enumText("voice").primaryKey(),
  harness: text().notNull().references("workbench_harnesses", "id"),
  model: text().notNull(),
  agent_path: text(),
  agent_source: enumText("library"),
  reasoning_effort: text(),
  service_tier: enumText("fast"),
  context_window_tokens: integer().nonNegative(),
});
const profileLink = defineTable("workbench_voice_profile_link", {
  id: enumText("voice").primaryKey().references("workbench_voice_settings", "id", { onDelete: "CASCADE" }),
  // Intentionally not a profile FK: deletion preserves the saved fallback.
  profile_id: text().notNull(),
});
const settingsHistory = defineTableHistory({ current: settings, versions: [
  tableVersion({ schemaVersion: releases.voiceProfiles.version, table: settings, migration: createTable(settings) }),
] });
const linkHistory = defineTableHistory({ current: profileLink, versions: [
  tableVersion({ schemaVersion: releases.voiceProfiles.version, table: profileLink, migration: createTable(profileLink) }),
] });
export const voiceSettings = settingsHistory.current;
export const voiceProfileLink = linkHistory.current;
export const voiceSettingsSchemaHistory = defineSubsystemHistory([settingsHistory, linkHistory]);
