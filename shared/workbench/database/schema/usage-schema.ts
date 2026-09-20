/*
 * Exports:
 * - threadTurnUsage: observed model context and cumulative turn counters.
 * - threadContextUsage: latest reported context measurement, independent of cumulative accounting.
 * - threadUsageModelAttributions: inferred model attribution.
 * - accountRateLimitSamples: dated account quota samples.
 * - accountRateLimitWindows: quota windows belonging to samples.
 * - gitClaimSessions: claim lifetimes.
 * - gitClaimThreadFileDays: daily claim activity.
 * - gitClaimImports: claim import checkpoints.
 * - threadUsageImports: usage import checkpoints.
 * - usageTables: current usage table registry.
 * - UsageSchemaRows: usage row types.
 * - usageSchemaHistory: additive and conversion steps.
 */
import databaseReleases from "./releases.ts";
import { ownProjectReferences } from "./project-schema.ts";
import { workbenchHarnesses } from "./core-schema.ts";
import {
  booleanInteger,
  check,
  defineTable,
  evolveTable,
  enumText,
  index,
  integer,
  literal,
  primaryKey,
  sql,
  text,
  unique,
  type SelectRow,
  type TableDefinition,
} from "../../../database/schema/schema-definition.ts";
import {
  addColumns,
  createTable,
  copyDistinctValues,
  defineSubsystemHistory,
  defineTableHistory,
  rebuildTable,
  tableVersion,
} from "../../../database/schema/schema-history.ts";

function initialHistory<Table extends TableDefinition>(table: Table, schemaVersion: number = databaseReleases.usage.version) {
  return defineTableHistory({
    current: table,
    versions: [tableVersion({ migration: createTable(table), schemaVersion, table })],
  });
}

const threadTurnUsageV1 = defineTable("thread_turn_usage", {
  turn_id: text().primaryKey().references("thread_turns", "id", { onDelete: "CASCADE" }),
  model: text(),
  service_tier: text(),
  input_tokens: integer().nonNegative(),
  cached_input_tokens: integer().nonNegative(),
  cache_write_input_tokens: integer().nonNegative(),
  output_tokens: integer().nonNegative(),
  reasoning_output_tokens: integer().nonNegative(),
  total_tokens: integer().nonNegative(),
  context_observed_at: integer(),
  usage_observed_at: integer(),
}, (table) => ({
  constraints: [
    check(sql`${table.service_tier} IS NULL OR ${table.service_tier} IN (${literal("fast")}, ${literal("priority")}, ${literal("standard")})`),
  ],
}));
const threadTurnUsageV2 = defineTable("thread_turn_usage", {
  turn_id: text().primaryKey().references("thread_turns", "id", { onDelete: "CASCADE" }),
  model: text(),
  service_tier: text(),
  cumulative_input_tokens: integer().nonNegative(),
  cumulative_cached_input_tokens: integer().nonNegative(),
  cumulative_cache_write_input_tokens: integer().nonNegative(),
  cumulative_output_tokens: integer().nonNegative(),
  cumulative_reasoning_output_tokens: integer().nonNegative(),
  cumulative_total_tokens: integer().nonNegative(),
  usage_data_version: integer().nonNegative(),
  context_observed_at: integer(),
  usage_observed_at: integer(),
}, (table) => ({
  constraints: [
    check(sql`${table.service_tier} IS NULL OR ${table.service_tier} IN (${literal("fast")}, ${literal("priority")}, ${literal("standard")})`),
    check(sql`(${table.usage_data_version} IS NULL AND ${table.cumulative_input_tokens} IS NULL
      AND ${table.cumulative_cached_input_tokens} IS NULL AND ${table.cumulative_cache_write_input_tokens} IS NULL
      AND ${table.cumulative_output_tokens} IS NULL AND ${table.cumulative_reasoning_output_tokens} IS NULL
      AND ${table.cumulative_total_tokens} IS NULL AND ${table.usage_observed_at} IS NULL)
      OR (${table.usage_data_version} IS NOT NULL AND ${table.cumulative_input_tokens} IS NOT NULL
      AND ${table.cumulative_cached_input_tokens} IS NOT NULL AND ${table.cumulative_cache_write_input_tokens} IS NOT NULL
      AND ${table.cumulative_output_tokens} IS NOT NULL AND ${table.cumulative_reasoning_output_tokens} IS NOT NULL
      AND ${table.cumulative_total_tokens} IS NOT NULL AND ${table.usage_observed_at} IS NOT NULL)`),
  ],
}));
const threadTurnUsageV3 = evolveTable(threadTurnUsageV2, {
  add: { model_is_mixed: booleanInteger().notNull().default(0) },
});
const threadTurnUsageHistory = defineTableHistory({
  current: threadTurnUsageV3,
  versions: [
    tableVersion({ migration: createTable(threadTurnUsageV1), schemaVersion: databaseReleases.usage.version, table: threadTurnUsageV1 }),
    tableVersion({
      migration: rebuildTable({
        from: threadTurnUsageV1,
        map: ({ expression }) => ({ usage_observed_at: expression.integer`NULL` }),
        to: threadTurnUsageV2,
      }),
      schemaVersion: databaseReleases.usageImportDetails.version,
      table: threadTurnUsageV2,
    }),
    tableVersion({
      migration: addColumns({ from: threadTurnUsageV2, to: threadTurnUsageV3, columns: ["model_is_mixed"] }),
      schemaVersion: databaseReleases.mixedModelUsage.version,
      table: threadTurnUsageV3,
    }),
  ],
});
export const threadTurnUsage = threadTurnUsageHistory.current;

const threadContextUsageV1 = defineTable("thread_context_usage", {
  thread_id: text().primaryKey().references("workbench_threads", "id", { onDelete: "CASCADE" }),
  state: enumText("reported", "unavailable").notNull(),
  model_context_window: integer().nonNegative(),
  last_input_tokens: integer().nonNegative(),
  last_cached_input_tokens: integer().nonNegative(),
  last_cache_write_input_tokens: integer().nonNegative(),
  last_output_tokens: integer().nonNegative(),
  last_reasoning_output_tokens: integer().nonNegative(),
  last_total_tokens: integer().nonNegative(),
  total_input_tokens: integer().nonNegative(),
  total_cached_input_tokens: integer().nonNegative(),
  total_cache_write_input_tokens: integer().nonNegative(),
  total_output_tokens: integer().nonNegative(),
  total_reasoning_output_tokens: integer().nonNegative(),
  total_tokens: integer().nonNegative(),
}, (table) => ({
  constraints: [
    check(sql`${table.model_context_window} IS NULL OR ${table.model_context_window} > 0`),
    check(sql`(${table.state} = ${literal("unavailable")}
      AND ${table.model_context_window} IS NULL AND ${table.last_input_tokens} IS NULL
      AND ${table.last_cached_input_tokens} IS NULL AND ${table.last_cache_write_input_tokens} IS NULL
      AND ${table.last_output_tokens} IS NULL AND ${table.last_reasoning_output_tokens} IS NULL
      AND ${table.last_total_tokens} IS NULL AND ${table.total_input_tokens} IS NULL
      AND ${table.total_cached_input_tokens} IS NULL AND ${table.total_cache_write_input_tokens} IS NULL
      AND ${table.total_output_tokens} IS NULL AND ${table.total_reasoning_output_tokens} IS NULL
      AND ${table.total_tokens} IS NULL)
      OR (${table.state} = ${literal("reported")} AND ${table.last_input_tokens} IS NOT NULL
      AND ${table.last_cached_input_tokens} IS NOT NULL AND ${table.last_cache_write_input_tokens} IS NOT NULL
      AND ${table.last_output_tokens} IS NOT NULL AND ${table.last_reasoning_output_tokens} IS NOT NULL
      AND ${table.last_total_tokens} IS NOT NULL AND ${table.total_input_tokens} IS NOT NULL
      AND ${table.total_cached_input_tokens} IS NOT NULL AND ${table.total_cache_write_input_tokens} IS NOT NULL
      AND ${table.total_output_tokens} IS NOT NULL AND ${table.total_reasoning_output_tokens} IS NOT NULL
      AND ${table.total_tokens} IS NOT NULL)`),
  ],
}));
const threadContextUsageHistory = initialHistory(threadContextUsageV1, databaseReleases.threadContextUsage.version);
export const threadContextUsage = threadContextUsageHistory.current;

const threadUsageModelAttributionsV1 = defineTable("thread_usage_model_attributions", {
  turn_id: text().primaryKey().references("thread_turn_usage", "turn_id", { onDelete: "CASCADE" }),
  model: text().notNull(),
  source: enumText("thread", "project", "provider").notNull(),
  policy_version: integer().notNull().nonNegative(),
  updated_at: integer().notNull().nonNegative(),
});
const threadUsageModelAttributionsHistory = initialHistory(threadUsageModelAttributionsV1, databaseReleases.usageAttribution.version);
export const threadUsageModelAttributions = threadUsageModelAttributionsHistory.current;

const accountRateLimitSamplesV1 = defineTable("account_rate_limit_samples", {
  id: integer().primaryKey({ autoincrement: true }),
  harness_id: text().notNull(),
  limit_id: text().notNull(),
  limit_name: text(),
  observed_at: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [unique([table.harness_id, table.limit_id, table.observed_at])],
  indexes: [index("account_rate_limit_samples_range_idx", [table.observed_at, table.harness_id])],
}));
const accountRateLimitSamplesHistory = initialHistory(accountRateLimitSamplesV1);
export const accountRateLimitSamples = accountRateLimitSamplesHistory.current;

const accountRateLimitWindowsV1 = defineTable("account_rate_limit_windows", {
  sample_id: integer().notNull().references("account_rate_limit_samples", "id", { onDelete: "CASCADE" }),
  window_kind: enumText("primary", "secondary").notNull(),
  used_basis_points: integer().notNull().nonNegative(),
  duration_minutes: integer().nonNegative(),
  resets_at: integer().nonNegative(),
}, (table) => ({
  constraints: [
    unique([table.sample_id, table.window_kind]),
    check(sql`${table.used_basis_points} <= ${literal(10_000)}`),
  ],
}));
const accountRateLimitWindowsV2 = defineTable("account_rate_limit_windows", {
  sample_id: integer().notNull().references("account_rate_limit_samples", "id", { onDelete: "CASCADE" }),
  window_kind: enumText("primary", "secondary", "tertiary").notNull(),
  used_basis_points: integer().notNull().nonNegative(),
  duration_minutes: integer().nonNegative(),
  resets_at: integer().nonNegative(),
}, (table) => ({
  constraints: [
    unique([table.sample_id, table.window_kind]),
    check(sql`${table.used_basis_points} <= ${literal(10_000)}`),
  ],
}));
const accountRateLimitWindowsHistory = defineTableHistory({
  current: accountRateLimitWindowsV2,
  versions: [
    tableVersion({ migration: createTable(accountRateLimitWindowsV1), schemaVersion: databaseReleases.usage.version, table: accountRateLimitWindowsV1 }),
    tableVersion({
      migration: rebuildTable({ from: accountRateLimitWindowsV1, to: accountRateLimitWindowsV2 }),
      schemaVersion: databaseReleases.tertiaryRateLimits.version,
      table: accountRateLimitWindowsV2,
    }),
  ],
});
export const accountRateLimitWindows = accountRateLimitWindowsHistory.current;

const gitClaimSessionsV1 = defineTable("git_claim_sessions", {
  id: integer().primaryKey({ autoincrement: true }),
  project_id: text().notNull(),
  root_id: text().notNull(),
  harness_id: text().notNull(),
  thread_id: text().notNull(),
  claimed_path: text().notNull(),
  claimed_at: integer().notNull().nonNegative(),
  released_at: integer().nonNegative(),
}, (table) => ({
  constraints: [check(sql`${table.released_at} IS NULL OR ${table.released_at} >= ${table.claimed_at}`)],
  indexes: [
    index("git_claim_sessions_range_idx", [table.project_id, table.claimed_at, table.released_at]),
    index("git_claim_sessions_open_idx", [
      table.project_id, table.root_id, table.harness_id, table.thread_id, table.claimed_path,
    ], { unique: true, where: sql`${table.released_at} IS NULL` }),
  ],
}));
const gitClaimSessionsHistory = initialHistory(gitClaimSessionsV1);
export const gitClaimSessions = gitClaimSessionsHistory.current;

const gitClaimThreadFileDaysV1 = defineTable("git_claim_thread_file_days", {
  project_id: text().notNull(),
  root_id: text().notNull(),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  thread_id: text().notNull(),
  claimed_path: text().notNull(),
  claimed_day: integer().notNull().nonNegative(),
}, (table) => ({
  constraints: [primaryKey([
    table.project_id, table.root_id, table.harness_id, table.thread_id, table.claimed_path, table.claimed_day,
  ])],
  indexes: [index("git_claim_thread_file_days_range_idx", [table.project_id, table.claimed_day, table.claimed_path])],
}));
const gitClaimThreadFileDaysV2 = evolveTable(gitClaimThreadFileDaysV1, {
  drop: ["harness_id"],
  add: { harness_id: text().notNull().references("workbench_harnesses", "id") },
});
const gitClaimThreadFileDaysHistory = defineTableHistory({
  current: gitClaimThreadFileDaysV2,
  versions: [
    ...initialHistory(gitClaimThreadFileDaysV1, databaseReleases.usageAttribution.version).versions,
    tableVersion({
      schemaVersion: databaseReleases.providerReferences.version, table: gitClaimThreadFileDaysV2,
      migration: [
        copyDistinctValues({ from: gitClaimThreadFileDaysV1, sourceColumn: "harness_id", to: workbenchHarnesses, targetColumn: "id" }),
        rebuildTable({ from: gitClaimThreadFileDaysV1, to: gitClaimThreadFileDaysV2 }),
      ],
    }),
  ],
});
export const gitClaimThreadFileDays = gitClaimThreadFileDaysHistory.current;

const gitClaimImportsV1 = defineTable("git_claim_imports", {
  project_id: text().notNull(),
  root_id: text().notNull(),
  repository_root: text().notNull(),
  workspace_root: text().notNull(),
  checkpoint_ref: text().notNull(),
  checkpoint_commit: text().notNull(),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  thread_id: text().notNull(),
  observed_at: integer().notNull().nonNegative(),
  state: enumText("pending", "processing", "completed", "failed").notNull(),
  run_id: text(),
  attempt_count: integer().notNull().default(0).nonNegative(),
  updated_at: integer().notNull().nonNegative(),
  error_text: text(),
}, (table) => ({
  constraints: [
    primaryKey([table.project_id, table.root_id, table.checkpoint_ref]),
    check(sql`${table.state} = ${literal("processing")} OR ${table.run_id} IS NULL`),
    check(sql`${table.state} != ${literal("processing")} OR ${table.run_id} IS NOT NULL`),
  ],
  indexes: [index("git_claim_imports_queue_idx", [table.state, table.observed_at])],
}));
const gitClaimImportsV2 = evolveTable(gitClaimImportsV1, {
  drop: ["harness_id"],
  add: { harness_id: text().notNull().references("workbench_harnesses", "id") },
});
const gitClaimImportsHistory = defineTableHistory({
  current: gitClaimImportsV2,
  versions: [
    ...initialHistory(gitClaimImportsV1, databaseReleases.usageAttribution.version).versions,
    tableVersion({
      schemaVersion: databaseReleases.providerReferences.version, table: gitClaimImportsV2,
      migration: [
        copyDistinctValues({ from: gitClaimImportsV1, sourceColumn: "harness_id", to: workbenchHarnesses, targetColumn: "id" }),
        rebuildTable({ from: gitClaimImportsV1, to: gitClaimImportsV2 }),
      ],
    }),
  ],
});
export const gitClaimImports = gitClaimImportsHistory.current;

const threadUsageImportsV1 = defineTable("thread_usage_imports", {
  project_id: text().notNull(),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  provider_thread_id: text().notNull(),
  state: enumText("pending", "processing", "completed", "unavailable", "failed").notNull(),
  run_id: text(),
  attempt_count: integer().notNull().default(0).nonNegative(),
  discovered_at: integer().notNull().nonNegative(),
  source_activity_at: integer().notNull().nonNegative(),
  started_at: integer().nonNegative(),
  settled_at: integer().nonNegative(),
  updated_at: integer().notNull().nonNegative(),
  error_text: text(),
}, (table) => ({
  constraints: [
    unique([table.project_id, table.harness_id, table.provider_thread_id]),
    check(sql`${table.state} = ${literal("processing")} OR ${table.run_id} IS NULL`),
    check(sql`${table.state} != ${literal("processing")} OR ${table.run_id} IS NOT NULL`),
  ],
  indexes: [index("thread_usage_imports_queue_idx", [table.state, table.source_activity_at])],
}));
const threadUsageImportsV2 = defineTable("thread_usage_imports", {
  project_id: text().notNull(),
  harness_id: enumText("codex", "copilot", "opencode").notNull(),
  provider_thread_id: text().notNull(),
  state: enumText("pending", "processing", "completed", "unavailable", "failed").notNull(),
  run_id: text(),
  attempt_count: integer().notNull().default(0).nonNegative(),
  discovered_at: integer().notNull().nonNegative(),
  source_activity_at: integer().notNull().nonNegative(),
  started_at: integer().nonNegative(),
  settled_at: integer().nonNegative(),
  updated_at: integer().notNull().nonNegative(),
  error_text: text(),
  completed_data_version: integer().nonNegative(),
}, (table) => ({
  constraints: [
    unique([table.project_id, table.harness_id, table.provider_thread_id]),
    check(sql`${table.state} = ${literal("processing")} OR ${table.run_id} IS NULL`),
    check(sql`${table.state} != ${literal("processing")} OR ${table.run_id} IS NOT NULL`),
  ],
  indexes: [index("thread_usage_imports_queue_idx", [table.state, table.source_activity_at])],
}));
const threadUsageImportsV3 = evolveTable(threadUsageImportsV2, {
  drop: ["harness_id"],
  add: { harness_id: text().notNull().references("workbench_harnesses", "id") },
});
const threadUsageImportsHistory = defineTableHistory({
  current: threadUsageImportsV3,
  versions: [
    tableVersion({ migration: createTable(threadUsageImportsV1), schemaVersion: databaseReleases.usageImports.version, table: threadUsageImportsV1 }),
    tableVersion({
      migration: addColumns({
        columns: ["completed_data_version"],
        from: threadUsageImportsV1,
        to: threadUsageImportsV2,
      }),
      schemaVersion: databaseReleases.usageImportDetails.version,
      table: threadUsageImportsV2,
    }),
    tableVersion({
      schemaVersion: databaseReleases.providerReferences.version, table: threadUsageImportsV3,
      migration: [
        copyDistinctValues({ from: threadUsageImportsV2, sourceColumn: "harness_id", to: workbenchHarnesses, targetColumn: "id" }),
        rebuildTable({ from: threadUsageImportsV2, to: threadUsageImportsV3 }),
      ],
    }),
  ],
});
export const threadUsageImports = threadUsageImportsHistory.current;

export const usageTables = Object.freeze({
  threadContextUsage,
  accountRateLimitSamples,
  accountRateLimitWindows,
  gitClaimImports,
  gitClaimSessions,
  gitClaimThreadFileDays,
  threadUsageImports,
  threadUsageModelAttributions,
  threadTurnUsage,
});
export type UsageSchemaRows = {
  [Name in keyof typeof usageTables]: SelectRow<(typeof usageTables)[Name]>;
};
export const usageSchemaHistory = defineSubsystemHistory([
  threadContextUsageHistory,
  threadTurnUsageHistory,
  threadUsageModelAttributionsHistory,
  accountRateLimitSamplesHistory,
  accountRateLimitWindowsHistory,
  ownProjectReferences(gitClaimSessionsHistory),
  ownProjectReferences(gitClaimThreadFileDaysHistory),
  ownProjectReferences(gitClaimImportsHistory),
  ownProjectReferences(threadUsageImportsHistory),
]);
