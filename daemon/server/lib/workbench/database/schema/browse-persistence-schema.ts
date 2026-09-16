/*
 * Exports:
 * - browseSessions: Workbench session ownership and activity catalogue.
 * - browseProfiles: persistent Chromium profile catalogue, excluding browser-owned files.
 * - browsePersistenceSchemaHistory: Browse catalogue history.
 */
import { defineTable, enumText, evolveTable, index, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, rebuildTable, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const sessions = defineTable("workbench_browse_sessions", {
  name: text().primaryKey(),
  cwd: text(),
  inactive_since: text(),
  last_action_at: text().notNull(),
  mode: enumText("headed", "headless"),
  project_id: text(),
  project_root_path: text(),
  thread_id: text(),
}, table => ({
  indexes: [
    index("workbench_browse_sessions_thread_idx", [table.thread_id]),
    index("workbench_browse_sessions_project_idx", [table.project_id]),
  ],
}));
const profiles = defineTable("workbench_browse_profiles", {
  name: text().primaryKey(),
  created_at: text().notNull(),
  last_used_at: text().notNull(),
  profile_path: text().notNull(),
});
const ownedSessions = evolveTable(sessions, {
  drop: ["project_id"],
  add: { project_id: text().references("workbench_projects", "id") },
});
const sessionHistory = defineTableHistory({
  current: ownedSessions,
  versions: [
    tableVersion({ schemaVersion: releases.externalCatalogues.version, table: sessions, migration: createTable(sessions) }),
    tableVersion({ schemaVersion: releases.browseProjectOwnership.version, table: ownedSessions, migration: rebuildTable({ from: sessions, to: ownedSessions }) }),
  ],
});
const profileHistory = defineTableHistory({
  current: profiles,
  versions: [tableVersion({ schemaVersion: releases.externalCatalogues.version, table: profiles, migration: createTable(profiles) })],
});
export const browseSessions = sessionHistory.current;
export const browseProfiles = profileHistory.current;
export const browsePersistenceSchemaHistory = defineSubsystemHistory([sessionHistory, profileHistory]);
