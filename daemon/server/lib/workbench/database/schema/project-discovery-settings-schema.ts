/*
 * Exports:
 * - projectDiscoveryRoots: ordered daemon-owned discovery folders.
 * - projectDiscoverySettingsSchemaHistory: additive discovery settings schema.
 */
import { defineTable, integer, text } from "workbench-shared/database/schema/schema-definition";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "workbench-shared/database/schema/schema-history";
import releases from "workbench-shared/workbench/database/schema/releases";

const roots = defineTable("workbench_project_discovery_roots", {
  position: integer().primaryKey().nonNegative(),
  path: text().notNull().unique(),
});
const history = defineTableHistory({
  current: roots,
  versions: [tableVersion({ schemaVersion: releases.projectDiscoveryRoots.version, table: roots, migration: createTable(roots) })],
});
export const projectDiscoveryRoots = history.current;
export const projectDiscoverySettingsSchemaHistory = defineSubsystemHistory([history]);
