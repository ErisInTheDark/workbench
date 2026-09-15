/*
 * Exports:
 * - projectTables/ProjectSchemaRows: typed project metadata, ordered roots, and legacy addresses.
 * - projectSchemaHistory: project storage installation before reference admission.
 * - admitProjectReferences: backfill project parents from an existing reference history.
 * - ownProjectReferences: add restrictive ownership after protected identity conversion.
 */
import databaseReleases from "./releases.ts";
import {
  check, defineTable, enumText, evolveTable, foreignKey, integer, literal, primaryKey, sql, text, unique,
  type SelectRow, type TableDefinition,
} from "../../../database/schema/schema-definition.ts";
import {
  copyDistinctValues, createTable, defineSubsystemHistory, defineTableHistory, rebuildTable, tableVersion,
  type TableHistory,
} from "../../../database/schema/schema-history.ts";

function defineProjects(canonicalIdentity: boolean) {
  return defineTable("workbench_projects", {
    id: text().primaryKey(),
    kind: enumText("historical", "git", "workspace", "workbench-library").notNull().default("historical"),
    name: text(),
    relative_path: text(),
    workspace_path: text(),
    last_commit_time_ms: integer(),
    icon_source_key: text(),
    icon_root_id: text(),
    icon_path: text(),
    icon_checked_at: integer().nonNegative(),
  }, table => ({
    constraints: [
      ...(canonicalIdentity ? [check(sql`
      ${table.id} = ${literal("workbench-library")}
      OR ${table.id} GLOB ${literal("remote://?*")}
      OR ${table.id} GLOB ${literal("local://?*")}
      OR ${table.id} GLOB ${literal("workspace://?*")}
    `)] : []),
      check(sql`
      (${table.kind} = ${literal("historical")} AND ${table.name} IS NULL AND ${table.relative_path} IS NULL
        AND ${table.workspace_path} IS NULL AND ${table.icon_source_key} IS NULL
        AND ${table.icon_checked_at} IS NULL AND ${table.icon_root_id} IS NULL AND ${table.icon_path} IS NULL)
      OR (${table.kind} <> ${literal("historical")} AND ${table.name} IS NOT NULL
        AND ${table.relative_path} IS NOT NULL AND ${table.icon_source_key} IS NOT NULL
        AND ((${table.kind} = ${literal("workspace")} AND ${table.workspace_path} IS NOT NULL)
          OR (${table.kind} <> ${literal("workspace")} AND ${table.workspace_path} IS NULL)))
    `),
      check(sql`
      (${table.icon_root_id} IS NULL AND ${table.icon_path} IS NULL)
      OR (${table.icon_root_id} IS NOT NULL AND ${table.icon_path} IS NOT NULL AND ${table.icon_checked_at} IS NOT NULL)
    `),
      foreignKey([table.id, table.icon_root_id], { table: "workbench_project_roots", columns: ["project_id", "root_id"] }),
    ],
  }));
}
const projects = defineProjects(false);
const canonicalProjects = defineProjects(true);

const roots = defineTable("workbench_project_roots", {
  project_id: text().notNull().references("workbench_projects", "id"),
  root_id: text().notNull(),
  root_index: integer().notNull().nonNegative(),
  name: text().notNull(),
  relative_path: text().notNull(),
  root_path: text().notNull(),
}, table => ({
  constraints: [
    primaryKey([table.project_id, table.root_id]),
    unique([table.project_id, table.root_index]),
  ],
}));

const aliases = defineTable("workbench_project_aliases", {
  alias: text().primaryKey(),
  project_id: text().notNull().references("workbench_projects", "id"),
}, table => ({ constraints: [check(sql`${table.alias} <> ${table.project_id}`)] }));

function initial<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    current: table,
    versions: [tableVersion({
      schemaVersion: databaseReleases.projectIdentity.version, table, migration: createTable(table),
    })],
  });
}

const projectsHistory = defineTableHistory({
  current: canonicalProjects,
  versions: [
    ...initial(projects).versions,
    tableVersion({
      schemaVersion: databaseReleases.projectOwnership.version,
      table: canonicalProjects,
      migration: rebuildTable({ from: projects, to: canonicalProjects }),
    }),
  ],
});
const rootsHistory = initial(roots);
const aliasesHistory = initial(aliases);
export const projectTables = Object.freeze({
  projects: projectsHistory.current, roots: rootsHistory.current, aliases: aliasesHistory.current,
});
export type ProjectSchemaRows = {
  [Name in keyof typeof projectTables]: SelectRow<(typeof projectTables)[Name]>;
};
export const projectSchemaHistory = defineSubsystemHistory([projectsHistory, rootsHistory, aliasesHistory]);

export function admitProjectReferences<Table extends TableDefinition>(
  history: TableHistory<Table>,
  sourceColumn: keyof Table["columns"] & string = "project_id",
): TableHistory<Table> {
  const previous = history.versions.at(-1)!.table as Table;
  return defineTableHistory({
    current: previous,
    versions: [
      ...history.versions,
      tableVersion({
        schemaVersion: databaseReleases.projectIdentity.version,
        table: previous,
        migration: copyDistinctValues({ from: previous, sourceColumn, to: projects, targetColumn: "id" }),
      }),
    ],
  });
}

export function ownProjectReferences<Table extends TableDefinition>(
  history: TableHistory<Table>,
  sourceColumn: keyof Table["columns"] & string = "project_id",
): TableHistory<Table> {
  const admitted = admitProjectReferences(history, sourceColumn);
  const previous = admitted.versions.at(-1)!.table as Table;
  const owned = evolveTable(previous, {
    drop: Object.keys(previous.columns),
    add: { ...previous.columns, [sourceColumn]: previous.columns[sourceColumn]!.references("workbench_projects", "id") },
  }) as Table;
  return defineTableHistory({
    current: owned,
    versions: [
      ...admitted.versions,
      tableVersion({
        schemaVersion: databaseReleases.projectOwnership.version,
        table: owned, migration: rebuildTable({ from: previous, to: owned }),
      }),
    ],
  });
}
