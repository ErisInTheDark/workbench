/*
 * workbenchThreadStateProjects: current project thread-state document table. Keywords: database, schema, thread state, project.
 * workbenchThreadStateGlobals: current Workbench-wide thread-state document table. Keywords: database, schema, thread state, global.
 * threadStateTables: current thread-state table inventory. Keywords: database, schema, thread state.
 * ThreadStateSchemaRows: selected row types for current thread-state tables. Keywords: database, schema, thread state, types.
 * threadStateSchemaHistory: private thread-state table histories. Keywords: database, schema, thread state, history.
 */
import {
  defineTable,
  enumText,
  integer,
  jsonText,
  text,
  type SelectRow,
} from "workbench-shared/database/schema/schema-definition";
import {
  createTable,
  defineSubsystemHistory,
  defineTableHistory,
  tableVersion,
} from "workbench-shared/database/schema/schema-history";

const workbenchThreadStateProjectsV1 = defineTable("workbench_thread_state_projects", {
  project_id: text().primaryKey(),
  document_json: jsonText().notNull(),
  updated_at: integer().notNull().nonNegative(),
});
const workbenchThreadStateProjectsHistory = defineTableHistory({
  versions: [tableVersion({
    schemaVersion: 3,
    table: workbenchThreadStateProjectsV1,
    migration: createTable(workbenchThreadStateProjectsV1),
  })],
  current: workbenchThreadStateProjectsV1,
});
export const workbenchThreadStateProjects = workbenchThreadStateProjectsHistory.current;

const workbenchThreadStateGlobalsV1 = defineTable("workbench_thread_state_globals", {
  id: enumText("homeDisplayOrder", "pinnedLayout").primaryKey(),
  document_json: jsonText().notNull(),
  updated_at: integer().notNull().nonNegative(),
});
const workbenchThreadStateGlobalsHistory = defineTableHistory({
  versions: [tableVersion({
    schemaVersion: 3,
    table: workbenchThreadStateGlobalsV1,
    migration: createTable(workbenchThreadStateGlobalsV1),
  })],
  current: workbenchThreadStateGlobalsV1,
});
export const workbenchThreadStateGlobals = workbenchThreadStateGlobalsHistory.current;

export const threadStateTables = Object.freeze({
  workbenchThreadStateGlobals,
  workbenchThreadStateProjects,
});

export type ThreadStateSchemaRows = {
  [Name in keyof typeof threadStateTables]: SelectRow<(typeof threadStateTables)[Name]>;
};

export const threadStateSchemaHistory = defineSubsystemHistory([
  workbenchThreadStateProjectsHistory,
  workbenchThreadStateGlobalsHistory,
]);
