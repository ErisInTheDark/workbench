/*
 * Exports:
 * - composerProfiles: named profiles with typed settings and scope.
 * - composerProfileTables/composerProfileSchemaHistory: current catalogue inventory and schema history.
 */
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { ownProjectReferences } from "workbench-shared/workbench/database/schema/project-schema";
import { workbenchHarnesses } from "workbench-shared/workbench/database/schema/core-schema";
import { check, defineTable, enumText, evolveTable, integer, literal, sql, text } from "workbench-shared/database/schema/schema-definition";
import { addColumns, copyDistinctValues, createTable, defineSubsystemHistory, defineTableHistory, rebuildTable, tableVersion, retireTableHistory } from "workbench-shared/database/schema/schema-history";

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
const contextProfiles = evolveTable(profiles, { add: { context_window_tokens: integer().nonNegative() } });
const usageProfiles = evolveTable(contextProfiles, { add: { last_used_at: integer().nonNegative() } });
const providerProfiles = evolveTable(usageProfiles, {
  drop: ["harness"],
  add: { harness: text().notNull().references("workbench_harnesses", "id") },
});
const profileHistory = defineTableHistory({
  current: providerProfiles,
  versions: [
    tableVersion({ schemaVersion: databaseReleases.composerProfiles.version, table: profiles, migration: createTable(profiles) }),
    tableVersion({
      schemaVersion: databaseReleases.profileContextWindows.version, table: contextProfiles,
      migration: addColumns({ from: profiles, to: contextProfiles, columns: ["context_window_tokens"] }),
    }),
    tableVersion({
      schemaVersion: databaseReleases.profileTurnUsage.version, table: usageProfiles,
      migration: addColumns({ from: contextProfiles, to: usageProfiles, columns: ["last_used_at"] }),
    }),
    tableVersion({
      schemaVersion: databaseReleases.providerReferences.version, table: providerProfiles,
      migration: [
        copyDistinctValues({ from: usageProfiles, sourceColumn: "harness", to: workbenchHarnesses, targetColumn: "id" }),
        rebuildTable({ from: usageProfiles, to: providerProfiles }),
      ],
    }),
  ],
});
const importHistory = defineTableHistory({
  current: imports,
  versions: [tableVersion({ schemaVersion: databaseReleases.composerProfiles.version, table: imports, migration: createTable(imports) })],
});
export const composerProfiles = profileHistory.current;
export const composerProfileTables = Object.freeze({ composerProfiles });
export const composerProfileSchemaHistory = defineSubsystemHistory([
  ownProjectReferences(profileHistory, "scope_project_id"),
  retireTableHistory(importHistory, databaseReleases.retireLegacyImportReceipts.version),
]);
