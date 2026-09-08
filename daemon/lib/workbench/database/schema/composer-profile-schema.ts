/*
 * Keywords: composer, profile, sqlite, catalogue, import, constraints.
 * Exports:
 * - composerProfiles: named profiles with typed settings and scope.
 * - composerProfileImports: durable legacy-import completion.
 * - composerProfileTables/composerProfileSchemaHistory: current catalogue inventory and schema history.
 */
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { check, defineTable, enumText, integer, literal, sql, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";

const profiles = defineTable("workbench_composer_profiles", {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text(),
  agent_path: text(),
  agent_source: enumText("library", "project"),
  harness: enumText("codex", "copilot", "opencode").notNull(),
  model: text().notNull(),
  reasoning_effort: text(),
  service_tier: enumText("fast"),
  scope_kind: enumText("global", "project").notNull(),
  scope_project_id: text(),
  created_at: integer().notNull().nonNegative(),
  updated_at: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    check(sql`(${table.scope_kind} = ${literal("global")} AND ${table.scope_project_id} IS NULL) OR (${table.scope_kind} = ${literal("project")} AND ${table.scope_project_id} IS NOT NULL)`),
    check(sql`${table.agent_source} IS NULL OR (${table.agent_path} IS NOT NULL AND (${table.agent_source} <> ${literal("project")} OR ${table.scope_kind} = ${literal("project")}))`),
    check(sql`${table.service_tier} IS NULL OR ${table.harness} = ${literal("codex")}`),
    check(sql`${table.updated_at} >= ${table.created_at}`),
  ],
}));
const imports = defineTable("workbench_composer_profile_imports", {
  id: enumText("legacy-json").primaryKey(),
});
const profileHistory = defineTableHistory({
  current: profiles,
  versions: [tableVersion({ schemaVersion: databaseReleases.composerProfiles.version, table: profiles, migration: createTable(profiles) })],
});
const importHistory = defineTableHistory({
  current: imports,
  versions: [tableVersion({ schemaVersion: databaseReleases.composerProfiles.version, table: imports, migration: createTable(imports) })],
});
export const composerProfiles = profileHistory.current;
export const composerProfileImports = importHistory.current;
export const composerProfileTables = Object.freeze({ composerProfiles, composerProfileImports });
export const composerProfileSchemaHistory = defineSubsystemHistory([profileHistory, importHistory]);
