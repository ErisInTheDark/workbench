/*
 * Exports:
 * - workbenchThreadStateProjects: authoritative project documents.
 * - workbenchThreadStateGlobals: authoritative global documents.
 * - workbenchThreadStateProjectionStatus: shadow health and source coverage.
 * - workbenchThreadStateThreads: projected canonical thread roots.
 * - workbenchThreadStateProviderIdentities: private native references.
 * - workbenchThreadStateLifecycles: thread lifecycle variants.
 * - workbenchThreadStateSubagents: child thread metadata.
 * - workbenchThreadStateSubagentParents: parent identity and next child index.
 * - workbenchThreadStateSubagentRelationships: stable relationship roots.
 * - workbenchThreadStatePendingSubagentRelationships: pending reservation details.
 * - workbenchThreadStateActiveSubagentRelationships: active child references.
 * - workbenchThreadStateRetention: thread cleanup metadata.
 * - workbenchThreadStateProfiles: thread profile selections.
 * - workbenchThreadStateProjectProfiles: project profile defaults.
 * - workbenchThreadStateSnoozeDependencies: wake dependencies.
 * - workbenchThreadStateDrafts: durable draft inputs.
 * - workbenchThreadStateDraftAttachments: opaque attachment values.
 * - workbenchThreadStateLayouts: stable layout roots.
 * - workbenchThreadStateProjectLayouts: project layout owners.
 * - workbenchThreadStateGlobalLayouts: global layout owners.
 * - workbenchThreadStateLayoutFolders: folder metadata.
 * - workbenchThreadStateLayoutItems: stable typed layout members.
 * - workbenchThreadStateLayoutThreadItems: thread member targets.
 * - workbenchThreadStateLayoutDraftItems: draft member targets.
 * - workbenchThreadStateLayoutFolderItems: folder member targets.
 * - workbenchThreadStateLayoutRelations: sidebar ordering relations.
 * - workbenchThreadStateFolderMembers: ordered folder membership.
 * - workbenchThreadStatePinnedImports: imported project markers.
 * - workbenchThreadStateQuestionnaires: interaction roots.
 * - workbenchThreadStateQuestionnaireQuestions: ordered questions.
 * - workbenchThreadStateQuestionnaireOptions: offered choices.
 * - workbenchThreadStateQuestionnaireAnswers: settled answers.
 * - threadStateRelationalTables: non-serving relational projection inventory.
 * - threadStateTables: complete thread-state table inventory.
 * - ThreadStateSchemaRows: current row types.
 * - threadStateSchemaHistory: private table histories.
 */
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { workbenchHarnesses } from "workbench-shared/workbench/database/schema/core-schema";
import {
  booleanInteger,
  check,
  defineTable,
  enumText,
  evolveTable,
  foreignKey,
  integer,
  jsonText,
  literal,
  primaryKey,
  sql,
  text,
  unique,
  type SelectRow,
  type SqlFragment,
  type TableDefinition,
} from "workbench-shared/database/schema/schema-definition";
import {
  createTable,
  copyDistinctValues,
  defineSubsystemHistory,
  defineTableHistory,
  rebuildTable,
  tableVersion,
} from "workbench-shared/database/schema/schema-history";

function initialHistory<Table extends TableDefinition>(table: Table, schemaVersion: number = databaseReleases.threadState.version) {
  return defineTableHistory({
    versions: [tableVersion({ schemaVersion, table, migration: createTable(table) })],
    current: table,
  });
}

function migrationText<Value extends string>(fragment: SqlFragment<string>) {
  return fragment as SqlFragment<Value>;
}

const workbenchThreadStateProjectsV1 = defineTable("workbench_thread_state_projects", {
  project_id: text().primaryKey(),
  document_json: jsonText().notNull(),
  updated_at: integer().notNull().nonNegative(),
});
const workbenchThreadStateProjectsHistory = initialHistory(workbenchThreadStateProjectsV1, databaseReleases.threadStateGlobals.version);
export const workbenchThreadStateProjects = workbenchThreadStateProjectsHistory.current;

const workbenchThreadStateGlobalsV1 = defineTable("workbench_thread_state_globals", {
  id: enumText("homeDisplayOrder", "pinnedLayout").primaryKey(),
  document_json: jsonText().notNull(),
  updated_at: integer().notNull().nonNegative(),
});
const workbenchThreadStateGlobalsHistory = initialHistory(workbenchThreadStateGlobalsV1, databaseReleases.threadStateGlobals.version);
export const workbenchThreadStateGlobals = workbenchThreadStateGlobalsHistory.current;

const workbenchThreadStateProjectionStatusV1 = defineTable("workbench_thread_state_projection_status", {
  id: integer().primaryKey(),
  generation: integer().notNull().nonNegative(),
  state: enumText("stale", "complete", "failed").notNull(),
  source_project_count: integer().notNull().nonNegative(),
  source_project_updated_at: integer().notNull().nonNegative(),
  source_subagent_parent_count: integer().notNull().nonNegative(),
  source_subagent_count: integer().notNull().nonNegative(),
  source_digest: text().notNull(),
  projected_thread_count: integer().notNull().nonNegative(),
  projected_subagent_count: integer().notNull().nonNegative(),
  mismatch_count: integer().notNull().nonNegative(),
  completed_at: integer(),
  error_text: text(),
  updated_at: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    check(sql`${table.id} = ${literal(1)}`),
    check(sql`length(${table.source_digest}) = ${literal(64)}`),
    check(sql`
      (${table.state} = ${literal("complete")} AND ${table.mismatch_count} = ${literal(0)} AND ${table.completed_at} IS NOT NULL AND ${table.error_text} IS NULL)
      OR (${table.state} = ${literal("stale")} AND ${table.completed_at} IS NULL AND ${table.error_text} IS NULL)
      OR (${table.state} = ${literal("failed")} AND ${table.completed_at} IS NULL AND ${table.error_text} IS NOT NULL)
    `),
  ],
}));
const workbenchThreadStateProjectionStatusV2 = evolveTable(workbenchThreadStateProjectionStatusV1, {
  add: { error_code: enumText("constraint-failure", "invalid-source", "projection-failure") },
  extras: (table) => ({
    constraints: [
      check(sql`${table.id} = ${literal(1)}`),
      check(sql`length(${table.source_digest}) = ${literal(64)}`),
      check(sql`
        (${table.state} = ${literal("complete")} AND ${table.mismatch_count} = ${literal(0)} AND ${table.completed_at} IS NOT NULL AND ${table.error_code} IS NULL AND ${table.error_text} IS NULL)
        OR (${table.state} = ${literal("stale")} AND ${table.completed_at} IS NULL AND ${table.error_code} IS NULL AND ${table.error_text} IS NULL)
        OR (${table.state} = ${literal("failed")} AND ${table.completed_at} IS NULL AND ${table.error_code} IS NOT NULL AND ${table.error_text} IS NOT NULL)
      `),
    ],
  }),
});
const workbenchThreadStateProjectionStatusHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: databaseReleases.threadState.version, table: workbenchThreadStateProjectionStatusV1, migration: createTable(workbenchThreadStateProjectionStatusV1) }),
    tableVersion({
      schemaVersion: databaseReleases.threadStateRelationships.version,
      table: workbenchThreadStateProjectionStatusV2,
      migration: rebuildTable({
        from: workbenchThreadStateProjectionStatusV1,
        to: workbenchThreadStateProjectionStatusV2,
        map: ({ from, expression }) => ({
          error_code: migrationText<"constraint-failure" | "invalid-source" | "projection-failure">(
            expression.text`CASE WHEN ${from.state} = 'failed' THEN 'projection-failure' ELSE NULL END`,
          ),
        }),
      }),
    }),
  ],
  current: workbenchThreadStateProjectionStatusV2,
});
export const workbenchThreadStateProjectionStatus = workbenchThreadStateProjectionStatusHistory.current;

const workbenchThreadStateThreadsV1 = defineTable("workbench_thread_state_threads", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  thread_kind: enumText("topLevel", "subagent").notNull(),
  visibility: enumText("visible", "placeholder").notNull().default("placeholder"),
  title: text().notNull(),
  archived: booleanInteger().notNull(),
  pinned: booleanInteger().notNull(),
  snoozed: booleanInteger().notNull(),
  provider_observed: booleanInteger().notNull(),
  created_at: integer().notNull().nonNegative(),
  updated_at: integer().notNull().nonNegative(),
  activity_at: integer().notNull().nonNegative(),
  order_at: integer().nonNegative(),
}, (table) => ({
  constraints: [
    unique([table.id, table.thread_kind]),
    check(sql`
      (${table.thread_kind} = ${literal("topLevel")} AND (
        ${table.archived} = ${literal(0)}
        OR (${table.pinned} = ${literal(0)} AND ${table.snoozed} = ${literal(0)})
      ))
      OR (${table.thread_kind} = ${literal("subagent")}
        AND ${table.archived} = ${literal(0)}
        AND ${table.snoozed} = ${literal(0)}
        AND ${table.order_at} IS NULL)
    `),
  ],
}));
const workbenchThreadStateThreadsV2 = evolveTable(workbenchThreadStateThreadsV1, {
  extras: (table) => ({
    constraints: [
      unique([table.id, table.project_id]),
      unique([table.id, table.thread_kind]),
      check(sql`
        (${table.thread_kind} = ${literal("topLevel")} AND (
          ${table.archived} = ${literal(0)}
          OR (${table.pinned} = ${literal(0)} AND ${table.snoozed} = ${literal(0)})
        ))
        OR (${table.thread_kind} = ${literal("subagent")}
          AND ${table.archived} = ${literal(0)}
          AND ${table.snoozed} = ${literal(0)}
          AND ${table.order_at} IS NULL)
      `),
    ],
  }),
});
const workbenchThreadStateThreadsHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: databaseReleases.threadState.version, table: workbenchThreadStateThreadsV1, migration: createTable(workbenchThreadStateThreadsV1) }),
    tableVersion({ schemaVersion: databaseReleases.threadStateRelationships.version, table: workbenchThreadStateThreadsV2, migration: rebuildTable({ from: workbenchThreadStateThreadsV1, to: workbenchThreadStateThreadsV2 }) }),
  ],
  current: workbenchThreadStateThreadsV2,
});
export const workbenchThreadStateThreads = workbenchThreadStateThreadsHistory.current;

const workbenchThreadStateProviderIdentitiesV1 = defineTable("workbench_thread_state_provider_identities", {
  thread_id: text().primaryKey().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  provider_thread_id: text().notNull(),
}, (table) => ({
  constraints: [unique([table.harness_id, table.provider_thread_id])],
}));
const workbenchThreadStateProviderIdentitiesV2 = evolveTable(workbenchThreadStateProviderIdentitiesV1, {
  add: { project_id: text().notNull() },
  extras: (table) => ({
    constraints: [
      foreignKey([table.thread_id, table.project_id], {
        table: "workbench_thread_state_threads", columns: ["id", "project_id"], onDelete: "CASCADE",
      }),
      unique([table.project_id, table.harness_id, table.provider_thread_id]),
    ],
  }),
});
const workbenchThreadStateProviderIdentitiesV3 = defineTable("workbench_thread_state_provider_identities", {
  project_id: text().notNull(),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  provider_thread_id: text().notNull(),
  thread_id: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.project_id, table.harness_id, table.provider_thread_id]),
    foreignKey([table.thread_id, table.project_id], {
      table: "workbench_thread_state_threads", columns: ["id", "project_id"], onDelete: "CASCADE",
    }),
  ],
}));
const workbenchThreadStateProviderIdentitiesV4 = evolveTable(workbenchThreadStateProviderIdentitiesV3, {
  drop: ["harness_id"],
  add: { harness_id: text().notNull().references("workbench_harnesses", "id") },
});
const workbenchThreadStateProviderIdentitiesHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: databaseReleases.threadState.version, table: workbenchThreadStateProviderIdentitiesV1, migration: createTable(workbenchThreadStateProviderIdentitiesV1) }),
    tableVersion({
      schemaVersion: databaseReleases.threadStateRelationships.version,
      table: workbenchThreadStateProviderIdentitiesV2,
      migration: rebuildTable({
        from: workbenchThreadStateProviderIdentitiesV1,
        to: workbenchThreadStateProviderIdentitiesV2,
        map: ({ from, expression }) => ({
          project_id: expression.text`(SELECT project_id FROM workbench_thread_state_threads WHERE id = ${from.thread_id})`,
        }),
      }),
    }),
    tableVersion({
      schemaVersion: databaseReleases.scopedThreadStateRelationships.version, table: workbenchThreadStateProviderIdentitiesV3,
      migration: rebuildTable({ from: workbenchThreadStateProviderIdentitiesV2, to: workbenchThreadStateProviderIdentitiesV3 }),
    }),
    tableVersion({
      schemaVersion: databaseReleases.providerReferences.version, table: workbenchThreadStateProviderIdentitiesV4,
      migration: [
        copyDistinctValues({ from: workbenchThreadStateProviderIdentitiesV3, sourceColumn: "harness_id", to: workbenchHarnesses, targetColumn: "id" }),
        rebuildTable({ from: workbenchThreadStateProviderIdentitiesV3, to: workbenchThreadStateProviderIdentitiesV4 }),
      ],
    }),
  ],
  current: workbenchThreadStateProviderIdentitiesV4,
});
export const workbenchThreadStateProviderIdentities = workbenchThreadStateProviderIdentitiesHistory.current;

const workbenchThreadStateLifecyclesV1 = defineTable("workbench_thread_state_lifecycles", {
  thread_id: text().primaryKey().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
  lifecycle_kind: enumText("working", "needsAttention", "completed", "stopped").notNull(),
  reason: enumText(
    "acceptedIntent",
    "pendingInput",
    "noActiveTurn",
    "agentBlocked",
    "agentCompleted",
    "userCompleted",
    "providerInactive",
    "providerInterrupted",
    "userMarkedStopped",
  ).notNull(),
  settled: booleanInteger().notNull(),
  provider_turn_id: text(),
  request_key: text(),
  agent_status: enumText("working", "completed", "blocked"),
}, (table) => ({
  constraints: [
    check(sql`
      (${table.lifecycle_kind} = ${literal("working")}
        AND ${table.reason} = ${literal("acceptedIntent")}
        AND ${table.settled} = ${literal(0)}
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} = ${literal("working")})
      OR (${table.lifecycle_kind} = ${literal("needsAttention")}
        AND ${table.reason} = ${literal("pendingInput")}
        AND ${table.settled} = ${literal(0)}
        AND ${table.provider_turn_id} IS NOT NULL
        AND ${table.request_key} IS NOT NULL
        AND ${table.agent_status} IS NULL)
      OR (${table.lifecycle_kind} = ${literal("needsAttention")}
        AND ${table.reason} = ${literal("noActiveTurn")}
        AND ${table.settled} = ${literal(0)}
        AND ${table.provider_turn_id} IS NULL
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} IS NULL)
      OR (${table.lifecycle_kind} = ${literal("needsAttention")}
        AND ${table.reason} = ${literal("agentBlocked")}
        AND ${table.settled} = ${literal(0)}
        AND ${table.provider_turn_id} IS NOT NULL
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} = ${literal("blocked")})
      OR (${table.lifecycle_kind} = ${literal("completed")}
        AND ${table.reason} = ${literal("agentCompleted")}
        AND ${table.provider_turn_id} IS NOT NULL
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} = ${literal("completed")})
      OR (${table.lifecycle_kind} = ${literal("completed")}
        AND ${table.reason} = ${literal("userCompleted")}
        AND ${table.request_key} IS NULL
        AND ((${table.provider_turn_id} IS NULL AND ${table.agent_status} IS NULL)
          OR (${table.provider_turn_id} IS NOT NULL AND ${table.agent_status} IS NOT NULL)))
      OR (${table.lifecycle_kind} = ${literal("completed")}
        AND ${table.reason} = ${literal("providerInactive")}
        AND ${table.provider_turn_id} IS NULL
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} IS NULL)
      OR (${table.lifecycle_kind} = ${literal("stopped")}
        AND ${table.reason} = ${literal("providerInterrupted")}
        AND ${table.provider_turn_id} IS NOT NULL
        AND ${table.request_key} IS NULL
        AND ${table.agent_status} IS NULL)
      OR (${table.lifecycle_kind} = ${literal("stopped")}
        AND ${table.reason} = ${literal("userMarkedStopped")}
        AND ${table.request_key} IS NULL
        AND ((${table.provider_turn_id} IS NULL AND ${table.agent_status} IS NULL)
          OR (${table.provider_turn_id} IS NOT NULL AND ${table.agent_status} IS NOT NULL)))
    `),
    check(sql`${table.settled} = ${literal(0)} OR ${table.lifecycle_kind} IN (${literal("completed")}, ${literal("stopped")})`),
  ],
}));
const workbenchThreadStateLifecyclesHistory = initialHistory(workbenchThreadStateLifecyclesV1);
export const workbenchThreadStateLifecycles = workbenchThreadStateLifecyclesHistory.current;

const workbenchThreadStateSubagentsV1 = defineTable("workbench_thread_state_subagents", {
  thread_id: text().primaryKey(),
  thread_kind: enumText("subagent").notNull().default("subagent"),
  parent_thread_id: text().notNull().references("workbench_thread_state_threads", "id"),
  cwd: text().notNull(),
  name: text().notNull(),
  name_key: text().notNull(),
  profile_id: text().notNull(),
  profile_name: text().notNull(),
  direct_subagent_index: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    foreignKey([table.thread_id, table.thread_kind], {
      table: "workbench_thread_state_threads",
      columns: ["id", "thread_kind"],
      onDelete: "CASCADE",
    }),
    unique([table.parent_thread_id, table.direct_subagent_index]),
    unique([table.parent_thread_id, table.name_key]),
    check(sql`${table.thread_id} <> ${table.parent_thread_id}`),
  ],
}));
const workbenchThreadStateSubagentsV2 = evolveTable(workbenchThreadStateSubagentsV1, {
  extras: (table) => ({
    constraints: [
      foreignKey([table.thread_id, table.thread_kind], {
        table: "workbench_thread_state_threads",
        columns: ["id", "thread_kind"],
        onDelete: "CASCADE",
      }),
      check(sql`${table.thread_id} <> ${table.parent_thread_id}`),
    ],
  }),
});
const workbenchThreadStateSubagentsHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: databaseReleases.threadState.version, table: workbenchThreadStateSubagentsV1, migration: createTable(workbenchThreadStateSubagentsV1) }),
    tableVersion({ schemaVersion: databaseReleases.threadStateRelationships.version, table: workbenchThreadStateSubagentsV2, migration: rebuildTable({ from: workbenchThreadStateSubagentsV1, to: workbenchThreadStateSubagentsV2 }) }),
  ],
  current: workbenchThreadStateSubagentsV2,
});
export const workbenchThreadStateSubagents = workbenchThreadStateSubagentsHistory.current;

const workbenchThreadStateSubagentParentsV1 = defineTable("workbench_thread_state_subagent_parents", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  parent_thread_id: text().notNull(),
  next_direct_subagent_index: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    foreignKey([table.parent_thread_id, table.project_id], {
      table: "workbench_thread_state_threads", columns: ["id", "project_id"], onDelete: "CASCADE",
    }),
    unique([table.project_id, table.harness_id, table.parent_thread_id]),
  ],
}));
const workbenchThreadStateSubagentParentsV2 = evolveTable(workbenchThreadStateSubagentParentsV1, {
  add: { legacy_id: text().unique() },
});
const workbenchThreadStateSubagentParentsV3 = evolveTable(workbenchThreadStateSubagentParentsV2, {
  drop: ["harness_id"],
  add: { harness_id: text().notNull().references("workbench_harnesses", "id") },
});
const workbenchThreadStateSubagentParentsHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: databaseReleases.threadStateRelationships.version, table: workbenchThreadStateSubagentParentsV1, migration: createTable(workbenchThreadStateSubagentParentsV1) }),
    tableVersion({
      schemaVersion: databaseReleases.scopedThreadStateRelationships.version, table: workbenchThreadStateSubagentParentsV2,
      migration: rebuildTable({ from: workbenchThreadStateSubagentParentsV1, to: workbenchThreadStateSubagentParentsV2 }),
    }),
    tableVersion({
      schemaVersion: databaseReleases.providerReferences.version, table: workbenchThreadStateSubagentParentsV3,
      migration: [
        copyDistinctValues({ from: workbenchThreadStateSubagentParentsV2, sourceColumn: "harness_id", to: workbenchHarnesses, targetColumn: "id" }),
        rebuildTable({ from: workbenchThreadStateSubagentParentsV2, to: workbenchThreadStateSubagentParentsV3 }),
      ],
    }),
  ],
  current: workbenchThreadStateSubagentParentsV3,
});
export const workbenchThreadStateSubagentParents = workbenchThreadStateSubagentParentsHistory.current;

const workbenchThreadStateSubagentRelationshipsV1 = defineTable("workbench_thread_state_subagent_relationships", {
  id: text().primaryKey(),
  parent_id: text().notNull().references("workbench_thread_state_subagent_parents", "id", { onDelete: "CASCADE" }),
  relationship_kind: enumText("pending", "active").notNull(),
  name_key: text().notNull(),
  direct_subagent_index: integer().notNull().nonNegative(),
  created_at: integer().notNull().nonNegative(),
  updated_at: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    unique([table.id, table.relationship_kind]),
    unique([table.parent_id, table.name_key]),
    unique([table.parent_id, table.direct_subagent_index]),
    check(sql`${table.updated_at} >= ${table.created_at}`),
  ],
}));
const workbenchThreadStateSubagentRelationshipsV2 = evolveTable(workbenchThreadStateSubagentRelationshipsV1, {
  add: { legacy_id: text().unique() },
});
const workbenchThreadStateSubagentRelationshipsHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: databaseReleases.threadStateRelationships.version, table: workbenchThreadStateSubagentRelationshipsV1, migration: createTable(workbenchThreadStateSubagentRelationshipsV1) }),
    tableVersion({
      schemaVersion: databaseReleases.scopedThreadStateRelationships.version, table: workbenchThreadStateSubagentRelationshipsV2,
      migration: rebuildTable({ from: workbenchThreadStateSubagentRelationshipsV1, to: workbenchThreadStateSubagentRelationshipsV2 }),
    }),
  ],
  current: workbenchThreadStateSubagentRelationshipsV2,
});
export const workbenchThreadStateSubagentRelationships = workbenchThreadStateSubagentRelationshipsHistory.current;

const workbenchThreadStatePendingSubagentRelationshipsV1 = defineTable("workbench_thread_state_pending_subagent_relationships", {
  relationship_id: text().primaryKey(),
  relationship_kind: enumText("pending").notNull().default("pending"),
  reservation_thread_id: text().notNull().unique(),
  cwd: text().notNull(),
  name: text().notNull(),
  profile_id: text().notNull(),
  profile_name: text().notNull(),
  title: text().notNull(),
}, (table) => ({
  constraints: [foreignKey([table.relationship_id, table.relationship_kind], {
    table: "workbench_thread_state_subagent_relationships", columns: ["id", "relationship_kind"], onDelete: "CASCADE",
  })],
}));
const workbenchThreadStatePendingSubagentRelationshipsV2 = evolveTable(workbenchThreadStatePendingSubagentRelationshipsV1, {
  drop: ["reservation_thread_id"],
  add: { reservation_id: text().notNull().unique() },
  extras: (table) => ({
    constraints: [foreignKey([table.relationship_id, table.relationship_kind], {
      table: "workbench_thread_state_subagent_relationships", columns: ["id", "relationship_kind"], onDelete: "CASCADE",
    })],
  }),
});
const workbenchThreadStatePendingSubagentRelationshipsHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: databaseReleases.threadStateRelationships.version, table: workbenchThreadStatePendingSubagentRelationshipsV1, migration: createTable(workbenchThreadStatePendingSubagentRelationshipsV1) }),
    tableVersion({
      schemaVersion: databaseReleases.scopedThreadStateRelationships.version, table: workbenchThreadStatePendingSubagentRelationshipsV2,
      migration: rebuildTable({
        from: workbenchThreadStatePendingSubagentRelationshipsV1, to: workbenchThreadStatePendingSubagentRelationshipsV2,
        map: ({ from, expression }) => ({ reservation_id: expression.text`substr(${from.reservation_thread_id}, 9)` }),
      }),
    }),
  ],
  current: workbenchThreadStatePendingSubagentRelationshipsV2,
});
export const workbenchThreadStatePendingSubagentRelationships = workbenchThreadStatePendingSubagentRelationshipsHistory.current;

const workbenchThreadStateActiveSubagentRelationshipsV1 = defineTable("workbench_thread_state_active_subagent_relationships", {
  relationship_id: text().primaryKey(),
  relationship_kind: enumText("active").notNull().default("active"),
  thread_id: text().notNull().unique().references("workbench_thread_state_subagents", "thread_id", { onDelete: "CASCADE" }),
}, (table) => ({
  constraints: [foreignKey([table.relationship_id, table.relationship_kind], {
    table: "workbench_thread_state_subagent_relationships", columns: ["id", "relationship_kind"], onDelete: "CASCADE",
  })],
}));
const workbenchThreadStateActiveSubagentRelationshipsHistory = initialHistory(workbenchThreadStateActiveSubagentRelationshipsV1, databaseReleases.threadStateRelationships.version);
export const workbenchThreadStateActiveSubagentRelationships = workbenchThreadStateActiveSubagentRelationshipsHistory.current;

const workbenchThreadStateRetentionV1 = defineTable("workbench_thread_state_retention", {
  thread_id: text().primaryKey().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
  settled_at: integer().nonNegative(),
  git_history_cleaned_at: integer().nonNegative(),
  mcp_generation: text(),
}, (table) => ({
  constraints: [check(sql`
    ${table.git_history_cleaned_at} IS NULL
    OR (${table.settled_at} IS NOT NULL AND ${table.git_history_cleaned_at} >= ${table.settled_at})
  `)],
}));
const workbenchThreadStateRetentionHistory = initialHistory(workbenchThreadStateRetentionV1);
export const workbenchThreadStateRetention = workbenchThreadStateRetentionHistory.current;

const profileColumns = {
  selection_kind: enumText("custom", "profile").notNull(),
  profile_id: text(),
  agent_path: text(),
  agent_source: enumText("library", "project"),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  model: text().notNull(),
  reasoning_effort: text(),
  service_tier: enumText("fast"),
};

const workbenchThreadStateProfilesV1 = defineTable("workbench_thread_state_profiles", {
  thread_id: text().primaryKey().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
  ...profileColumns,
}, (table) => ({
  constraints: [check(sql`
    (${table.selection_kind} = ${literal("custom")} AND ${table.profile_id} IS NULL)
    OR (${table.selection_kind} = ${literal("profile")} AND ${table.profile_id} IS NOT NULL)
  `)],
}));
const workbenchThreadStateProfilesV2 = evolveTable(workbenchThreadStateProfilesV1, {
  drop: ["harness_id"],
  add: { harness_id: text().notNull().references("workbench_harnesses", "id") },
});
const workbenchThreadStateProfilesHistory = defineTableHistory({
  current: workbenchThreadStateProfilesV2,
  versions: [
    ...initialHistory(workbenchThreadStateProfilesV1).versions,
    tableVersion({
      schemaVersion: databaseReleases.providerReferences.version, table: workbenchThreadStateProfilesV2,
      migration: [
        copyDistinctValues({ from: workbenchThreadStateProfilesV1, sourceColumn: "harness_id", to: workbenchHarnesses, targetColumn: "id" }),
        rebuildTable({ from: workbenchThreadStateProfilesV1, to: workbenchThreadStateProfilesV2 }),
      ],
    }),
  ],
});
export const workbenchThreadStateProfiles = workbenchThreadStateProfilesHistory.current;

const workbenchThreadStateProjectProfilesV1 = defineTable("workbench_thread_state_project_profiles", {
  project_id: text().primaryKey(),
  ...profileColumns,
}, (table) => ({
  constraints: [check(sql`
    (${table.selection_kind} = ${literal("custom")} AND ${table.profile_id} IS NULL)
    OR (${table.selection_kind} = ${literal("profile")} AND ${table.profile_id} IS NOT NULL)
  `)],
}));
const workbenchThreadStateProjectProfilesV2 = evolveTable(workbenchThreadStateProjectProfilesV1, {
  drop: ["harness_id"],
  add: { harness_id: text().notNull().references("workbench_harnesses", "id") },
});
const workbenchThreadStateProjectProfilesHistory = defineTableHistory({
  current: workbenchThreadStateProjectProfilesV2,
  versions: [
    ...initialHistory(workbenchThreadStateProjectProfilesV1).versions,
    tableVersion({
      schemaVersion: databaseReleases.providerReferences.version, table: workbenchThreadStateProjectProfilesV2,
      migration: [
        copyDistinctValues({ from: workbenchThreadStateProjectProfilesV1, sourceColumn: "harness_id", to: workbenchHarnesses, targetColumn: "id" }),
        rebuildTable({ from: workbenchThreadStateProjectProfilesV1, to: workbenchThreadStateProjectProfilesV2 }),
      ],
    }),
  ],
});
export const workbenchThreadStateProjectProfiles = workbenchThreadStateProjectProfilesHistory.current;

const workbenchThreadStateSnoozeDependenciesV1 = defineTable("workbench_thread_state_snooze_dependencies", {
  source_thread_id: text().primaryKey(),
  source_thread_kind: enumText("topLevel").notNull().default("topLevel"),
  target_thread_id: text().notNull(),
  target_thread_kind: enumText("topLevel").notNull().default("topLevel"),
}, (table) => ({
  constraints: [
    foreignKey([table.source_thread_id, table.source_thread_kind], {
      table: "workbench_thread_state_threads",
      columns: ["id", "thread_kind"],
      onDelete: "CASCADE",
    }),
    foreignKey([table.target_thread_id, table.target_thread_kind], {
      table: "workbench_thread_state_threads",
      columns: ["id", "thread_kind"],
    }),
    check(sql`${table.source_thread_id} <> ${table.target_thread_id}`),
  ],
}));
const workbenchThreadStateSnoozeDependenciesHistory = initialHistory(workbenchThreadStateSnoozeDependenciesV1);
export const workbenchThreadStateSnoozeDependencies = workbenchThreadStateSnoozeDependenciesHistory.current;

const workbenchThreadStateDraftsV1 = defineTable("workbench_thread_state_drafts", {
  draft_id: text().primaryKey(),
  project_id: text().notNull(),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  prompt: text().notNull(),
  profile_id: text(),
  agent_path: text(),
  agent_source: enumText("library", "project"),
  model: text().notNull(),
  reasoning_effort: text(),
  service_tier: enumText("fast"),
  pinned: booleanInteger().notNull(),
  snoozed: booleanInteger().notNull(),
  client_updated_at: integer().notNull().nonNegative(),
  created_at: integer().notNull().nonNegative(),
  updated_at: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [check(sql`NOT (${table.pinned} = ${literal(1)} AND ${table.snoozed} = ${literal(1)})`)],
}));
const workbenchThreadStateDraftsV2 = evolveTable(workbenchThreadStateDraftsV1, {
  drop: ["harness_id"],
  add: { harness_id: text().notNull().references("workbench_harnesses", "id") },
});
const workbenchThreadStateDraftsHistory = defineTableHistory({
  current: workbenchThreadStateDraftsV2,
  versions: [
    ...initialHistory(workbenchThreadStateDraftsV1).versions,
    tableVersion({
      schemaVersion: databaseReleases.providerReferences.version, table: workbenchThreadStateDraftsV2,
      migration: [
        copyDistinctValues({ from: workbenchThreadStateDraftsV1, sourceColumn: "harness_id", to: workbenchHarnesses, targetColumn: "id" }),
        rebuildTable({ from: workbenchThreadStateDraftsV1, to: workbenchThreadStateDraftsV2 }),
      ],
    }),
  ],
});
export const workbenchThreadStateDrafts = workbenchThreadStateDraftsHistory.current;

const workbenchThreadStateDraftAttachmentsV1 = defineTable("workbench_thread_state_draft_attachments", {
  draft_id: text().notNull().references("workbench_thread_state_drafts", "draft_id", { onDelete: "CASCADE" }),
  attachment_index: integer().notNull().nonNegative(),
  opaque_json: jsonText().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.draft_id, table.attachment_index])],
}));
const workbenchThreadStateDraftAttachmentsHistory = initialHistory(workbenchThreadStateDraftAttachmentsV1);
export const workbenchThreadStateDraftAttachments = workbenchThreadStateDraftAttachmentsHistory.current;

const workbenchThreadStateLayoutsV1 = defineTable("workbench_thread_state_layouts", {
  id: text().primaryKey(),
  owner_kind: enumText("project", "pinned", "home").notNull(),
  revision: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [unique([table.id, table.owner_kind])],
}));
const workbenchThreadStateLayoutsV2 = evolveTable(workbenchThreadStateLayoutsV1, {
  add: { legacy_id: text().unique() },
});
const workbenchThreadStateLayoutsHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: databaseReleases.threadState.version, table: workbenchThreadStateLayoutsV1, migration: createTable(workbenchThreadStateLayoutsV1) }),
    tableVersion({
      schemaVersion: databaseReleases.scopedThreadStateRelationships.version, table: workbenchThreadStateLayoutsV2,
      migration: rebuildTable({ from: workbenchThreadStateLayoutsV1, to: workbenchThreadStateLayoutsV2 }),
    }),
  ],
  current: workbenchThreadStateLayoutsV2,
});
export const workbenchThreadStateLayouts = workbenchThreadStateLayoutsHistory.current;

const workbenchThreadStateProjectLayoutsV1 = defineTable("workbench_thread_state_project_layouts", {
  layout_id: text().primaryKey(),
  owner_kind: enumText("project").notNull().default("project"),
  project_id: text().notNull().unique(),
}, (table) => ({
  constraints: [foreignKey([table.layout_id, table.owner_kind], {
    table: "workbench_thread_state_layouts",
    columns: ["id", "owner_kind"],
    onDelete: "CASCADE",
  })],
}));
const workbenchThreadStateProjectLayoutsHistory = initialHistory(workbenchThreadStateProjectLayoutsV1);
export const workbenchThreadStateProjectLayouts = workbenchThreadStateProjectLayoutsHistory.current;

const workbenchThreadStateGlobalLayoutsV1 = defineTable("workbench_thread_state_global_layouts", {
  layout_id: text().primaryKey(),
  owner_kind: enumText("pinned", "home").notNull(),
}, (table) => ({
  constraints: [foreignKey([table.layout_id, table.owner_kind], {
    table: "workbench_thread_state_layouts",
    columns: ["id", "owner_kind"],
    onDelete: "CASCADE",
  })],
}));
const workbenchThreadStateGlobalLayoutsHistory = initialHistory(workbenchThreadStateGlobalLayoutsV1);
export const workbenchThreadStateGlobalLayouts = workbenchThreadStateGlobalLayoutsHistory.current;

const workbenchThreadStateLayoutFoldersV1 = defineTable("workbench_thread_state_layout_folders", {
  folder_id: text().primaryKey(),
  layout_id: text().notNull(),
  layout_owner_kind: enumText("project", "pinned").notNull(),
  section: enumText("pinned", "snoozed", "settled").notNull(),
  title: text().notNull(),
}, (table) => ({
  constraints: [
    foreignKey([table.layout_id, table.layout_owner_kind], {
      table: "workbench_thread_state_layouts",
      columns: ["id", "owner_kind"],
      onDelete: "CASCADE",
    }),
    unique([table.folder_id, table.layout_id, table.section]),
  ],
}));
const workbenchThreadStateLayoutFoldersHistory = initialHistory(workbenchThreadStateLayoutFoldersV1);
export const workbenchThreadStateLayoutFolders = workbenchThreadStateLayoutFoldersHistory.current;

const workbenchThreadStateLayoutItemsV1 = defineTable("workbench_thread_state_layout_items", {
  id: text().primaryKey(),
  layout_id: text().notNull().references("workbench_thread_state_layouts", "id", { onDelete: "CASCADE" }),
  section: enumText("pinned", "snoozed", "settled").notNull(),
  item_kind: enumText("thread", "draft", "folder").notNull(),
}, (table) => ({
  constraints: [
    unique([table.id, table.item_kind]),
    unique([table.id, table.layout_id, table.section]),
    unique([table.id, table.layout_id, table.section, table.item_kind]),
  ],
}));
const workbenchThreadStateLayoutItemsV2 = evolveTable(workbenchThreadStateLayoutItemsV1, {
  add: { legacy_id: text().unique() },
});
const workbenchThreadStateLayoutItemsHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: databaseReleases.threadState.version, table: workbenchThreadStateLayoutItemsV1, migration: createTable(workbenchThreadStateLayoutItemsV1) }),
    tableVersion({
      schemaVersion: databaseReleases.scopedThreadStateRelationships.version, table: workbenchThreadStateLayoutItemsV2,
      migration: rebuildTable({ from: workbenchThreadStateLayoutItemsV1, to: workbenchThreadStateLayoutItemsV2 }),
    }),
  ],
  current: workbenchThreadStateLayoutItemsV2,
});
export const workbenchThreadStateLayoutItems = workbenchThreadStateLayoutItemsHistory.current;

const workbenchThreadStateLayoutThreadItemsV1 = defineTable("workbench_thread_state_layout_thread_items", {
  item_id: text().primaryKey(),
  item_kind: enumText("thread").notNull().default("thread"),
  thread_id: text().notNull().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_kind], {
    table: "workbench_thread_state_layout_items",
    columns: ["id", "item_kind"],
    onDelete: "CASCADE",
  })],
}));
const workbenchThreadStateLayoutThreadItemsHistory = initialHistory(workbenchThreadStateLayoutThreadItemsV1);
export const workbenchThreadStateLayoutThreadItems = workbenchThreadStateLayoutThreadItemsHistory.current;

const workbenchThreadStateLayoutDraftItemsV1 = defineTable("workbench_thread_state_layout_draft_items", {
  item_id: text().primaryKey(),
  item_kind: enumText("draft").notNull().default("draft"),
  draft_id: text().notNull().references("workbench_thread_state_drafts", "draft_id", { onDelete: "CASCADE" }),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_kind], {
    table: "workbench_thread_state_layout_items",
    columns: ["id", "item_kind"],
    onDelete: "CASCADE",
  })],
}));
const workbenchThreadStateLayoutDraftItemsHistory = initialHistory(workbenchThreadStateLayoutDraftItemsV1);
export const workbenchThreadStateLayoutDraftItems = workbenchThreadStateLayoutDraftItemsHistory.current;

const workbenchThreadStateLayoutFolderItemsV1 = defineTable("workbench_thread_state_layout_folder_items", {
  item_id: text().primaryKey(),
  item_kind: enumText("folder").notNull().default("folder"),
  folder_id: text().notNull().references("workbench_thread_state_layout_folders", "folder_id", { onDelete: "CASCADE" }),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.item_kind], {
    table: "workbench_thread_state_layout_items",
    columns: ["id", "item_kind"],
    onDelete: "CASCADE",
  })],
}));
const workbenchThreadStateLayoutFolderItemsHistory = initialHistory(workbenchThreadStateLayoutFolderItemsV1);
export const workbenchThreadStateLayoutFolderItems = workbenchThreadStateLayoutFolderItemsHistory.current;

const workbenchThreadStateLayoutRelationsV1 = defineTable("workbench_thread_state_layout_relations", {
  item_id: text().notNull(),
  related_item_id: text().notNull(),
  layout_id: text().notNull(),
  section: enumText("pinned", "snoozed", "settled").notNull(),
  relation_kind: enumText("above", "below").notNull(),
  relation_index: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.relation_kind, table.relation_index]),
    foreignKey([table.item_id, table.layout_id, table.section], {
      table: "workbench_thread_state_layout_items",
      columns: ["id", "layout_id", "section"],
      onDelete: "CASCADE",
    }),
    foreignKey([table.related_item_id, table.layout_id, table.section], {
      table: "workbench_thread_state_layout_items",
      columns: ["id", "layout_id", "section"],
      onDelete: "CASCADE",
    }),
    check(sql`${table.item_id} <> ${table.related_item_id}`),
  ],
}));
const workbenchThreadStateLayoutRelationsHistory = initialHistory(workbenchThreadStateLayoutRelationsV1);
export const workbenchThreadStateLayoutRelations = workbenchThreadStateLayoutRelationsHistory.current;

const workbenchThreadStateFolderMembersV1 = defineTable("workbench_thread_state_folder_members", {
  folder_item_id: text().notNull(),
  folder_item_kind: enumText("folder").notNull().default("folder"),
  member_item_id: text().notNull(),
  member_item_kind: enumText("thread", "draft").notNull(),
  layout_id: text().notNull(),
  section: enumText("pinned", "snoozed", "settled").notNull(),
  member_index: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [
    primaryKey([table.folder_item_id, table.member_index]),
    unique([table.layout_id, table.member_item_id]),
    foreignKey([table.folder_item_id, table.layout_id, table.section, table.folder_item_kind], {
      table: "workbench_thread_state_layout_items",
      columns: ["id", "layout_id", "section", "item_kind"],
      onDelete: "CASCADE",
    }),
    foreignKey([table.member_item_id, table.layout_id, table.section, table.member_item_kind], {
      table: "workbench_thread_state_layout_items",
      columns: ["id", "layout_id", "section", "item_kind"],
      onDelete: "CASCADE",
    }),
    check(sql`${table.folder_item_id} <> ${table.member_item_id}`),
  ],
}));
const workbenchThreadStateFolderMembersHistory = initialHistory(workbenchThreadStateFolderMembersV1);
export const workbenchThreadStateFolderMembers = workbenchThreadStateFolderMembersHistory.current;

const workbenchThreadStatePinnedImportsV1 = defineTable("workbench_thread_state_pinned_imports", {
  project_id: text().primaryKey(),
  layout_id: text().notNull().references("workbench_thread_state_layouts", "id", { onDelete: "CASCADE" }),
});
const workbenchThreadStatePinnedImportsHistory = initialHistory(workbenchThreadStatePinnedImportsV1);
export const workbenchThreadStatePinnedImports = workbenchThreadStatePinnedImportsHistory.current;

const workbenchThreadStateQuestionnairesV1 = defineTable("workbench_thread_state_questionnaires", {
  id: text().primaryKey(),
  thread_id: text().notNull().references("workbench_thread_state_threads", "id", { onDelete: "CASCADE" }),
  state: enumText("pending", "answered").notNull(),
  provider_turn_id: text(),
  provider_item_id: text(),
  request_key: text().notNull(),
  request_id: text().notNull(),
  title: text().notNull(),
  summary: text().notNull(),
  submit_label: text().notNull(),
  insert_after_item_id: text(),
  insert_after_item_index: integer().nonNegative(),
  resolved_at: integer().nonNegative(),
}, (table) => ({
  constraints: [
    unique([table.id, table.state]),
    unique([table.thread_id, table.request_key]),
    check(sql`
      (${table.state} = ${literal("pending")} AND ${table.resolved_at} IS NULL)
      OR (${table.state} = ${literal("answered")} AND ${table.resolved_at} IS NOT NULL)
    `),
  ],
}));
const workbenchThreadStateQuestionnairesV2 = evolveTable(workbenchThreadStateQuestionnairesV1, {
  add: { legacy_id: text().unique() },
  extras: (table) => ({
    constraints: [
      unique([table.id, table.state]),
      check(sql`
        (${table.state} = ${literal("pending")} AND ${table.resolved_at} IS NULL)
        OR (${table.state} = ${literal("answered")} AND ${table.resolved_at} IS NOT NULL)
      `),
    ],
  }),
});
const workbenchThreadStateQuestionnairesHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: databaseReleases.threadState.version, table: workbenchThreadStateQuestionnairesV1, migration: createTable(workbenchThreadStateQuestionnairesV1) }),
    tableVersion({
      schemaVersion: databaseReleases.scopedThreadStateRelationships.version, table: workbenchThreadStateQuestionnairesV2,
      migration: rebuildTable({ from: workbenchThreadStateQuestionnairesV1, to: workbenchThreadStateQuestionnairesV2 }),
    }),
  ],
  current: workbenchThreadStateQuestionnairesV2,
});
export const workbenchThreadStateQuestionnaires = workbenchThreadStateQuestionnairesHistory.current;

const workbenchThreadStateQuestionnaireQuestionsV1 = defineTable("workbench_thread_state_questionnaire_questions", {
  questionnaire_id: text().notNull().references("workbench_thread_state_questionnaires", "id", { onDelete: "CASCADE" }),
  question_index: integer().notNull().nonNegative(),
  question_id: text().notNull(),
  header: text().notNull(),
  question: text().notNull(),
  allow_other: booleanInteger().notNull(),
  is_secret: booleanInteger().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.questionnaire_id, table.question_index]),
    unique([table.questionnaire_id, table.question_id]),
  ],
}));
const workbenchThreadStateQuestionnaireQuestionsHistory = initialHistory(workbenchThreadStateQuestionnaireQuestionsV1);
export const workbenchThreadStateQuestionnaireQuestions = workbenchThreadStateQuestionnaireQuestionsHistory.current;

const workbenchThreadStateQuestionnaireOptionsV1 = defineTable("workbench_thread_state_questionnaire_options", {
  questionnaire_id: text().notNull(),
  question_index: integer().notNull(),
  option_index: integer().notNull().nonNegative(),
  label: text().notNull(),
  description: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.questionnaire_id, table.question_index, table.option_index]),
    foreignKey([table.questionnaire_id, table.question_index], {
      table: "workbench_thread_state_questionnaire_questions",
      columns: ["questionnaire_id", "question_index"],
      onDelete: "CASCADE",
    }),
  ],
}));
const workbenchThreadStateQuestionnaireOptionsHistory = initialHistory(workbenchThreadStateQuestionnaireOptionsV1);
export const workbenchThreadStateQuestionnaireOptions = workbenchThreadStateQuestionnaireOptionsHistory.current;

const workbenchThreadStateQuestionnaireAnswersV1 = defineTable("workbench_thread_state_questionnaire_answers", {
  questionnaire_id: text().notNull(),
  questionnaire_state: enumText("answered").notNull().default("answered"),
  question_id: text().notNull(),
  answer_index: integer().notNull().nonNegative(),
  answer: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.questionnaire_id, table.question_id, table.answer_index]),
    foreignKey([table.questionnaire_id, table.questionnaire_state], {
      table: "workbench_thread_state_questionnaires",
      columns: ["id", "state"],
      onDelete: "CASCADE",
    }),
    foreignKey([table.questionnaire_id, table.question_id], {
      table: "workbench_thread_state_questionnaire_questions",
      columns: ["questionnaire_id", "question_id"],
      onDelete: "CASCADE",
    }),
  ],
}));
const workbenchThreadStateQuestionnaireAnswersHistory = initialHistory(workbenchThreadStateQuestionnaireAnswersV1);
export const workbenchThreadStateQuestionnaireAnswers = workbenchThreadStateQuestionnaireAnswersHistory.current;

export const threadStateRelationalTables = Object.freeze({
  workbenchThreadStateProjectionStatus,
  workbenchThreadStateThreads,
  workbenchThreadStateProviderIdentities,
  workbenchThreadStateLifecycles,
  workbenchThreadStateSubagents,
  workbenchThreadStateSubagentParents,
  workbenchThreadStateSubagentRelationships,
  workbenchThreadStatePendingSubagentRelationships,
  workbenchThreadStateActiveSubagentRelationships,
  workbenchThreadStateRetention,
  workbenchThreadStateProfiles,
  workbenchThreadStateProjectProfiles,
  workbenchThreadStateSnoozeDependencies,
  workbenchThreadStateDrafts,
  workbenchThreadStateDraftAttachments,
  workbenchThreadStateLayouts,
  workbenchThreadStateProjectLayouts,
  workbenchThreadStateGlobalLayouts,
  workbenchThreadStateLayoutFolders,
  workbenchThreadStateLayoutItems,
  workbenchThreadStateLayoutThreadItems,
  workbenchThreadStateLayoutDraftItems,
  workbenchThreadStateLayoutFolderItems,
  workbenchThreadStateLayoutRelations,
  workbenchThreadStateFolderMembers,
  workbenchThreadStatePinnedImports,
  workbenchThreadStateQuestionnaires,
  workbenchThreadStateQuestionnaireQuestions,
  workbenchThreadStateQuestionnaireOptions,
  workbenchThreadStateQuestionnaireAnswers,
});

export const threadStateTables = Object.freeze({
  workbenchThreadStateGlobals,
  workbenchThreadStateProjects,
  ...threadStateRelationalTables,
});

export type ThreadStateSchemaRows = {
  [Name in keyof typeof threadStateTables]: SelectRow<(typeof threadStateTables)[Name]>;
};

export const threadStateSchemaHistory = defineSubsystemHistory([
  workbenchThreadStateProjectsHistory,
  workbenchThreadStateGlobalsHistory,
  workbenchThreadStateProjectionStatusHistory,
  workbenchThreadStateThreadsHistory,
  workbenchThreadStateProviderIdentitiesHistory,
  workbenchThreadStateLifecyclesHistory,
  workbenchThreadStateSubagentsHistory,
  workbenchThreadStateSubagentParentsHistory,
  workbenchThreadStateSubagentRelationshipsHistory,
  workbenchThreadStatePendingSubagentRelationshipsHistory,
  workbenchThreadStateActiveSubagentRelationshipsHistory,
  workbenchThreadStateRetentionHistory,
  workbenchThreadStateProfilesHistory,
  workbenchThreadStateProjectProfilesHistory,
  workbenchThreadStateSnoozeDependenciesHistory,
  workbenchThreadStateDraftsHistory,
  workbenchThreadStateDraftAttachmentsHistory,
  workbenchThreadStateLayoutsHistory,
  workbenchThreadStateProjectLayoutsHistory,
  workbenchThreadStateGlobalLayoutsHistory,
  workbenchThreadStateLayoutFoldersHistory,
  workbenchThreadStateLayoutItemsHistory,
  workbenchThreadStateLayoutThreadItemsHistory,
  workbenchThreadStateLayoutDraftItemsHistory,
  workbenchThreadStateLayoutFolderItemsHistory,
  workbenchThreadStateLayoutRelationsHistory,
  workbenchThreadStateFolderMembersHistory,
  workbenchThreadStatePinnedImportsHistory,
  workbenchThreadStateQuestionnairesHistory,
  workbenchThreadStateQuestionnaireQuestionsHistory,
  workbenchThreadStateQuestionnaireOptionsHistory,
  workbenchThreadStateQuestionnaireAnswersHistory,
]);
