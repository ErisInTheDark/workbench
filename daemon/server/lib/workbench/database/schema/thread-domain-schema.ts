/*
 * Exports:
 * - defineThreadDomainSchema: declare canonical thread facts and their installation history.
 */
import {
  booleanInteger, check, defineTable, enumText, evolveTable, foreignKey, index, integer, literal,
  primaryKey, sql, text, unique, type TableDefinition,
} from "workbench-shared/database/schema/schema-definition";
import {
  addColumns, createTable, defineSubsystemHistory, defineTableHistory, tableVersion, retireTableHistory,
} from "workbench-shared/database/schema/schema-history";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { ownProjectReferences } from "workbench-shared/workbench/database/schema/project-schema";

export function defineThreadDomainSchema(schemaVersion: number) {
  function install<Table extends TableDefinition>(table: Table) {
    return defineTableHistory({
      current: table,
      versions: [tableVersion({ schemaVersion, table, migration: createTable(table) })],
    });
  }

  function installProfile<Table extends TableDefinition>(table: Table) {
    const current = evolveTable(table, { add: { context_window_tokens: integer().nonNegative() } });
    return defineTableHistory({
      current,
      versions: [
        tableVersion({ schemaVersion, table, migration: createTable(table) }),
        tableVersion({
          schemaVersion: databaseReleases.profileContextWindows.version, table: current,
          migration: addColumns({ from: table, to: current, columns: ["context_window_tokens"] }),
        }),
      ],
    });
  }

  const states = install(defineTable("workbench_thread_states", {
    thread_id: text().primaryKey().references("workbench_threads", "id", { onDelete: "CASCADE" }),
    thread_kind: enumText("topLevel", "subagent").notNull(),
    harness_id: text().notNull().references("workbench_harnesses", "id"),
    title: text().notNull(),
    activity_at: integer().notNull().nonNegative(),
    provider_observed: booleanInteger().notNull(),
  }, (table) => ({
    constraints: [unique([table.thread_id, table.thread_kind])],
    indexes: [index("workbench_thread_states_activity_idx", [table.activity_at, table.thread_id])],
  })));

  const topLevel = install(defineTable("workbench_top_level_thread_states", {
    thread_id: text().primaryKey(),
    thread_kind: enumText("topLevel").notNull(),
    archived: booleanInteger().notNull(),
    pinned: booleanInteger().notNull(),
    snoozed: booleanInteger().notNull(),
    order_at: integer().nonNegative(),
  }, (table) => ({
    constraints: [
      foreignKey([table.thread_id, table.thread_kind], {
        table: "workbench_thread_states", columns: ["thread_id", "thread_kind"], onDelete: "CASCADE",
      }),
      check(sql`${table.archived} = ${literal(0)} OR (${table.pinned} = ${literal(0)} AND ${table.snoozed} = ${literal(0)})`),
    ],
    indexes: [index("workbench_top_level_thread_states_visibility_idx", [
      table.archived, table.pinned, table.snoozed, table.thread_id,
    ])],
  })));

  const subagents = install(defineTable("workbench_subagent_thread_states", {
    thread_id: text().primaryKey(),
    thread_kind: enumText("subagent").notNull(),
    parent_thread_id: text().notNull().references("workbench_threads", "id"),
    cwd: text().notNull(),
    name: text().notNull(),
    profile_id: text().notNull(),
    profile_name: text().notNull(),
    direct_subagent_index: integer().notNull().nonNegative(),
    created_at: integer().notNull().nonNegative(),
    updated_at: integer().notNull().nonNegative(),
    pinned: booleanInteger().notNull(),
  }, (table) => ({
    constraints: [
      foreignKey([table.thread_id, table.thread_kind], {
        table: "workbench_thread_states", columns: ["thread_id", "thread_kind"], onDelete: "CASCADE",
      }),
      check(sql`${table.thread_id} <> ${table.parent_thread_id}`),
    ],
    indexes: [index("workbench_subagent_thread_states_parent_idx", [
      table.parent_thread_id, table.direct_subagent_index, table.thread_id,
    ])],
  })));

  const retention = install(defineTable("workbench_thread_retention", {
    thread_id: text().primaryKey().references("workbench_thread_states", "thread_id", { onDelete: "CASCADE" }),
    settled_at: integer().nonNegative(),
    git_history_cleaned_at: integer().nonNegative(),
    mcp_generation: text(),
  }, (table) => ({
    indexes: [index("workbench_thread_retention_settled_idx", [table.settled_at, table.thread_id], {
      where: sql`${table.settled_at} IS NOT NULL`,
    })],
  })));

  const snoozeDependencies = install(defineTable("workbench_thread_snooze_dependencies", {
    source_thread_id: text().primaryKey().references("workbench_top_level_thread_states", "thread_id", { onDelete: "CASCADE" }),
    target_thread_id: text().notNull().references("workbench_top_level_thread_states", "thread_id"),
  }, (table) => ({
    constraints: [check(sql`${table.source_thread_id} <> ${table.target_thread_id}`)],
    indexes: [index("workbench_thread_snooze_dependencies_target_idx", [table.target_thread_id])],
  })));

  const profiles = installProfile(defineTable("workbench_thread_profiles", {
    thread_id: text().primaryKey().references("workbench_thread_states", "thread_id", { onDelete: "CASCADE" }),
    selection_kind: enumText("custom", "profile").notNull(),
    profile_id: text(),
    harness_id: text().notNull().references("workbench_harnesses", "id"),
    model: text().notNull(),
    reasoning_effort: text(),
    service_tier: enumText("fast"),
    agent_path: text(),
    agent_source: enumText("library", "project"),
  }, (table) => ({
    constraints: [check(sql`(${table.selection_kind} = ${literal("custom")} AND ${table.profile_id} IS NULL) OR (${table.selection_kind} = ${literal("profile")} AND ${table.profile_id} IS NOT NULL)`)],
  })));

  const projectProfiles = installProfile(defineTable("workbench_project_thread_profiles", {
    project_id: text().primaryKey(),
    selection_kind: enumText("custom", "profile").notNull(),
    profile_id: text(),
    harness_id: text().notNull().references("workbench_harnesses", "id"),
    model: text().notNull(),
    reasoning_effort: text(),
    service_tier: enumText("fast"),
    agent_path: text(),
    agent_source: enumText("library", "project"),
  }, (table) => ({
    constraints: [check(sql`(${table.selection_kind} = ${literal("custom")} AND ${table.profile_id} IS NULL) OR (${table.selection_kind} = ${literal("profile")} AND ${table.profile_id} IS NOT NULL)`)],
  })));

  const drafts = installProfile(defineTable("workbench_thread_drafts", {
    id: text().primaryKey(),
    draft_id: text().notNull(),
    project_id: text().notNull(),
    harness_id: text().notNull().references("workbench_harnesses", "id"),
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
    constraints: [unique([table.draft_id])],
    indexes: [index("workbench_thread_drafts_project_idx", [table.project_id, table.updated_at, table.id])],
  })));

  const attachments = install(defineTable("workbench_thread_draft_attachments", {
    draft_id: text().notNull().references("workbench_thread_drafts", "id", { onDelete: "CASCADE" }),
    attachment_index: integer().notNull().nonNegative(),
    attachment_id: text().notNull(),
    url: text().notNull(),
  }, (table) => ({ constraints: [primaryKey([table.draft_id, table.attachment_index])] })));

  const parents = install(defineTable("workbench_subagent_parents", {
    parent_thread_id: text().primaryKey().references("workbench_threads", "id"),
    next_direct_subagent_index: integer().notNull().nonNegative(),
  }));

  const relationships = install(defineTable("workbench_subagent_relationships", {
    id: text().primaryKey(),
    parent_thread_id: text().notNull().references("workbench_subagent_parents", "parent_thread_id"),
    relationship_kind: enumText("reserved", "active").notNull(),
    project_id: text().notNull(),
    name_key: text().notNull(),
    direct_subagent_index: integer().notNull().nonNegative(),
    created_at: integer().notNull().nonNegative(),
    updated_at: integer().notNull().nonNegative(),
  }, (table) => ({
    constraints: [
      unique([table.id, table.relationship_kind]),
      unique([table.parent_thread_id, table.name_key]),
      unique([table.parent_thread_id, table.direct_subagent_index]),
    ],
    indexes: [index("workbench_subagent_relationships_project_idx", [table.project_id, table.created_at, table.id])],
  })));

  const relationshipMetadata = install(defineTable("workbench_subagent_relationship_metadata", {
    relationship_id: text().primaryKey().references("workbench_subagent_relationships", "id", { onDelete: "CASCADE" }),
    harness_id: text().notNull().references("workbench_harnesses", "id"),
    cwd: text().notNull(),
    name: text().notNull(),
    title: text().notNull(),
    profile_id: text().notNull(),
    profile_name: text().notNull(),
  }));

  const activeRelationships = install(defineTable("workbench_active_subagent_relationships", {
    relationship_id: text().primaryKey(),
    relationship_kind: enumText("active").notNull(),
    thread_id: text().notNull().references("workbench_threads", "id"),
  }, (table) => ({
    constraints: [
      unique([table.thread_id]),
      foreignKey([table.relationship_id, table.relationship_kind], {
        table: "workbench_subagent_relationships", columns: ["id", "relationship_kind"], onDelete: "CASCADE",
      }),
    ],
  })));

  const importReceipt = install(defineTable("workbench_thread_state_import", {
    id: integer().primaryKey(),
    completed_at: integer().notNull().nonNegative(),
  }, (table) => ({ constraints: [check(sql`${table.id} = ${literal(1)}`)] })));

  const histories = {
    states, topLevel, subagents, retention, snoozeDependencies, profiles, projectProfiles,
    drafts, attachments, parents, relationships, relationshipMetadata, activeRelationships, importReceipt,
  };
  return {
    tables: {
      states: states.current, topLevel: topLevel.current, subagents: subagents.current,
      retention: retention.current, snoozeDependencies: snoozeDependencies.current,
      profiles: profiles.current, projectProfiles: projectProfiles.current,
      drafts: drafts.current, attachments: attachments.current, parents: parents.current,
      relationships: relationships.current, relationshipMetadata: relationshipMetadata.current,
      activeRelationships: activeRelationships.current,
    },
    history: defineSubsystemHistory(Object.values(histories).map(history => (
      history === importReceipt ? retireTableHistory(history, databaseReleases.retireLegacyImportReceipts.version)
        : "project_id" in history.current.columns ? ownProjectReferences<TableDefinition>(history) : history
    ))),
  };
}
