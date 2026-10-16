/*
 * Exports:
 * - voiceSettings/voiceProfileLink: typed global voice fallback, audio retention and optional profile link.
 * - voiceSettingsSchemaHistory: additive voice selection and audio retention schema.
 */
import { booleanInteger, defineTable, enumText, evolveTable, integer, text } from "workbench-shared/database/schema/schema-definition";
import { addColumns, createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const settingsV1 = defineTable("workbench_voice_settings", {
  id: enumText("voice").primaryKey(),
  harness: text().notNull().references("workbench_harnesses", "id"),
  model: text().notNull(),
  agent_path: text(),
  agent_source: enumText("library"),
  reasoning_effort: text(),
  service_tier: enumText("fast"),
  context_window_tokens: integer().nonNegative(),
});
const settings = evolveTable(settingsV1, { add: { record_audio: booleanInteger().notNull().default(0) } });
const profileLink = defineTable("workbench_voice_profile_link", {
  id: enumText("voice").primaryKey().references("workbench_voice_settings", "id", { onDelete: "CASCADE" }),
  // Intentionally not a profile FK: deletion preserves the saved fallback.
  profile_id: text().notNull(),
});
const settingsHistory = defineTableHistory({ current: settings, versions: [
  tableVersion({ schemaVersion: releases.voiceProfiles.version, table: settingsV1, migration: createTable(settingsV1) }),
  tableVersion({
    schemaVersion: releases.voiceRecordAudio.version,
    table: settings,
    migration: addColumns({ from: settingsV1, to: settings, columns: ["record_audio"] }),
  }),
] });
const linkHistory = defineTableHistory({ current: profileLink, versions: [
  tableVersion({ schemaVersion: releases.voiceProfiles.version, table: profileLink, migration: createTable(profileLink) }),
] });
export const voiceSettings = settingsHistory.current;
export const voiceProfileLink = linkHistory.current;
export const voiceSettingsSchemaHistory = defineSubsystemHistory([settingsHistory, linkHistory]);
