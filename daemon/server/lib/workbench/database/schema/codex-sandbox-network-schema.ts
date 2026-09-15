/*
 * codexSandboxNetworkGlobalSettings: global Codex sandbox network setting. Keywords: Codex, sandbox, network, global.
 * codexSandboxNetworkProjectOverrides: explicit per-project Codex sandbox network overrides. Keywords: Codex, sandbox, network, project.
 * codexSandboxNetworkTables: current Codex sandbox network table inventory. Keywords: Codex, sandbox, network, schema.
 * CodexSandboxNetworkSchemaRows: selected row types for current Codex sandbox network tables. Keywords: Codex, sandbox, network, types.
 * codexSandboxNetworkSchemaHistory: private Codex sandbox network table histories. Keywords: Codex, sandbox, network, history.
 */
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { ownProjectReferences } from "workbench-shared/workbench/database/schema/project-schema";
import {
  booleanInteger,
  defineTable,
  enumText,
  text,
  type SelectRow,
} from "workbench-shared/database/schema/schema-definition";
import {
  createTable,
  defineSubsystemHistory,
  defineTableHistory,
  tableVersion,
} from "workbench-shared/database/schema/schema-history";

const codexSandboxNetworkGlobalSettingsV1 = defineTable("codex_sandbox_network_global_settings", {
  id: enumText("global").primaryKey(),
  enabled: booleanInteger().notNull(),
});
const codexSandboxNetworkGlobalSettingsHistory = defineTableHistory({
  versions: [tableVersion({
    schemaVersion: databaseReleases.codexSandboxNetwork.version,
    table: codexSandboxNetworkGlobalSettingsV1,
    migration: createTable(codexSandboxNetworkGlobalSettingsV1),
  })],
  current: codexSandboxNetworkGlobalSettingsV1,
});
export const codexSandboxNetworkGlobalSettings = codexSandboxNetworkGlobalSettingsHistory.current;

const codexSandboxNetworkProjectOverridesV1 = defineTable("codex_sandbox_network_project_overrides", {
  project_id: text().primaryKey(),
  enabled: booleanInteger().notNull(),
});
const codexSandboxNetworkProjectOverridesHistory = defineTableHistory({
  versions: [tableVersion({
    schemaVersion: databaseReleases.codexSandboxNetwork.version,
    table: codexSandboxNetworkProjectOverridesV1,
    migration: createTable(codexSandboxNetworkProjectOverridesV1),
  })],
  current: codexSandboxNetworkProjectOverridesV1,
});
export const codexSandboxNetworkProjectOverrides = codexSandboxNetworkProjectOverridesHistory.current;

export const codexSandboxNetworkTables = Object.freeze({
  codexSandboxNetworkGlobalSettings,
  codexSandboxNetworkProjectOverrides,
});

export type CodexSandboxNetworkSchemaRows = {
  [Name in keyof typeof codexSandboxNetworkTables]: SelectRow<(typeof codexSandboxNetworkTables)[Name]>;
};

export const codexSandboxNetworkSchemaHistory = defineSubsystemHistory([
  codexSandboxNetworkGlobalSettingsHistory,
  ownProjectReferences(codexSandboxNetworkProjectOverridesHistory),
]);
