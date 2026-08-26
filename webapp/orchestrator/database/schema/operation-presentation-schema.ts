/*
 * threadOperationPresentations: current rematchable operation presentation root table. Keywords: database, schema, presentation.
 * threadOperationCommandPresentations: current command presentation table. Keywords: database, schema, command.
 * threadCommandSummaryParts: current ordered command summary part table. Keywords: database, schema, command.
 * threadCommandDetailRows: current ordered command detail table. Keywords: database, schema, command.
 * threadCommandDetailSummaryParts: current ordered detail summary part table. Keywords: database, schema, command.
 * threadCommandDetailImages: current ordered command detail image table. Keywords: database, schema, command.
 * threadOperationBrowsePresentations: current Browse presentation table. Keywords: database, schema, browse.
 * threadBrowsePresentationCommands: current ordered Browse presentation command table. Keywords: database, schema, browse.
 * threadOperationSkillPresentations: current skill presentation table. Keywords: database, schema, skill.
 * threadOperationSubagentTaskPresentations: current subagent task presentation table. Keywords: database, schema, subagent.
 * threadOperationGitArcPresentations: current Git arc presentation table. Keywords: database, schema, git.
 * threadGitArcPaths: current ordered Git arc path table. Keywords: database, schema, git.
 * threadGitArcMoveOperands: current ordered Git move operand table. Keywords: database, schema, git.
 * threadGitArcMoveMappings: current ordered Git move mapping table. Keywords: database, schema, git.
 * threadGitArcMoveRegexRoots: current ordered Git regex root table. Keywords: database, schema, git.
 * threadOperationSubagentPresentations: current subagent control presentation table. Keywords: database, schema, subagent.
 * threadSubagentTargets: current ordered subagent target table. Keywords: database, schema, subagent.
 * threadOperationThreadControlPresentations: current thread control presentation table. Keywords: database, schema, thread-control.
 * operationPresentationTables: current operation presentation table inventory. Keywords: database, schema, presentation.
 * OperationPresentationSchemaRows: selected row types for current presentation tables. Keywords: database, schema, types.
 * operationPresentationSchemaHistory: private operation presentation table histories. Keywords: database, schema, history.
 */
import {
  booleanInteger,
  check,
  defineTable,
  enumText,
  evolveTable,
  foreignKey,
  integer,
  literal,
  primaryKey,
  sql,
  text,
  unique,
  type SelectRow,
  type TableDefinition,
} from "./schema-definition.ts";
import { createTable, defineSubsystemHistory, defineTableHistory, rebuildTable, tableVersion } from "./schema-history.ts";

function initialHistory<Table extends TableDefinition>(table: Table) {
  return defineTableHistory({
    versions: [tableVersion({ schemaVersion: 1, table, migration: createTable(table) })],
    current: table,
  });
}

const threadOperationPresentationsV1 = defineTable("thread_operation_presentations", {
  item_id: text().primaryKey(),
  source_revision: integer().notNull(),
  presentation_type: enumText("command", "skill", "subagentTask", "gitArc", "subagent", "threadControl", "genericTool", "browse", "hidden").notNull(),
  presentation_revision: integer().notNull().nonNegative(),
  projector_id: text().notNull(),
  projection_digest: text().notNull(),
  projected_at: integer().notNull(),
}, (table) => ({
  constraints: [
    unique([table.item_id, table.presentation_type, table.presentation_revision]),
    foreignKey([table.item_id, table.source_revision], {
      table: "thread_item_operations",
      columns: ["item_id", "source_revision"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadOperationPresentationsHistory = initialHistory(threadOperationPresentationsV1);
export const threadOperationPresentations = threadOperationPresentationsHistory.current;

const threadOperationCommandPresentationsV1 = defineTable("thread_operation_command_presentations", {
  item_id: text().primaryKey(),
  presentation_type: enumText("command").notNull().default("command"),
  presentation_revision: integer().notNull(),
  claimed_by: text(),
  summary_kind: enumText("matched", "raw").notNull(),
  summary_text: text().notNull(),
  ongoing_summary_text: text().notNull(),
  full_command: text().notNull(),
  unwrapped_command: text().notNull(),
  cwd_display: text(),
  shell: enumText("bash", "cmd", "fish", "powershell", "pwsh", "sh", "shell", "zsh"),
  show_shell: booleanInteger().notNull(),
  hide_command_cwd: booleanInteger().notNull(),
  hide_command_output: booleanInteger().notNull(),
  omit_from_display: booleanInteger().notNull(),
  deleted_paths: integer().notNull(),
  git_checkpoint_creates: integer().notNull(),
  git_checkpoint_diffs: integer().notNull(),
  git_checkpoint_restores: integer().notNull(),
  git_diff_checks: integer().notNull(),
  git_status_checks: integer().notNull(),
  listed_files: integer().notNull(),
  other_commands: integer().notNull(),
  path_checks: integer().notNull(),
  read_files: integer().notNull(),
  searched_files: integer().notNull(),
  skill_loads: integer().notNull(),
  typescript_builds: integer().notNull(),
  typescript_validations: integer().notNull(),
  web_requests: integer().notNull(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.presentation_type, table.presentation_revision], {
    table: "thread_operation_presentations",
    columns: ["item_id", "presentation_type", "presentation_revision"],
    onDelete: "CASCADE",
  })],
}));
const threadOperationCommandPresentationsHistory = initialHistory(threadOperationCommandPresentationsV1);
export const threadOperationCommandPresentations = threadOperationCommandPresentationsHistory.current;

const threadCommandSummaryPartsV1 = defineTable("thread_command_summary_parts", {
  item_id: text().notNull().references("thread_operation_command_presentations", "item_id", { onDelete: "CASCADE" }),
  part_group: enumText("summary", "ongoing").notNull(),
  part_index: integer().notNull(),
  part_type: enumText("text", "skill", "path", "separator").notNull(),
  text: text(),
  text_variant: enumText("code", "plain", "primary"),
  clamp: booleanInteger(),
  skill_name: text(),
  skill_path: text(),
  path: text(),
  label: text(),
  line_number: integer(),
  column_number: integer(),
  separator_kind: text(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.part_group, table.part_index])],
}));
const threadCommandSummaryPartsHistory = initialHistory(threadCommandSummaryPartsV1);
export const threadCommandSummaryParts = threadCommandSummaryPartsHistory.current;

const threadCommandDetailRowsV1 = defineTable("thread_command_detail_rows", {
  item_id: text().notNull().references("thread_operation_command_presentations", "item_id", { onDelete: "CASCADE" }),
  row_index: integer().notNull(),
  row_id: text().notNull(),
  context_text: text(),
  detail_kind: enumText("duration", "error", "result", "text"),
  detail_label: text(),
  detail_text: text(),
  duration_ms: integer(),
  label: text(),
  state: enumText("completed", "failed", "inProgress", "queued"),
  target_kind: enumText("code", "text", "url"),
  target_text: text(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.row_index]),
    check(sql`
      (${table.target_kind} IS NULL AND ${table.target_text} IS NULL)
      OR (${table.target_kind} IS NOT NULL AND ${table.target_text} IS NOT NULL)
    `),
  ],
}));
const threadCommandDetailRowsHistory = initialHistory(threadCommandDetailRowsV1);
export const threadCommandDetailRows = threadCommandDetailRowsHistory.current;

const threadCommandDetailSummaryPartsV1 = defineTable("thread_command_detail_summary_parts", {
  item_id: text().notNull(),
  row_index: integer().notNull(),
  part_index: integer().notNull(),
  part_type: enumText("text", "skill", "path", "separator").notNull(),
  text: text(),
  text_variant: enumText("code", "plain", "primary"),
  clamp: booleanInteger(),
  skill_name: text(),
  skill_path: text(),
  path: text(),
  label: text(),
  line_number: integer(),
  column_number: integer(),
  separator_kind: text(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.row_index, table.part_index]),
    foreignKey([table.item_id, table.row_index], {
      table: "thread_command_detail_rows",
      columns: ["item_id", "row_index"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadCommandDetailSummaryPartsHistory = initialHistory(threadCommandDetailSummaryPartsV1);
export const threadCommandDetailSummaryParts = threadCommandDetailSummaryPartsHistory.current;

const threadCommandDetailImagesV1 = defineTable("thread_command_detail_images", {
  item_id: text().notNull(),
  row_index: integer().notNull(),
  image_group: enumText("single", "multiple").notNull(),
  image_index: integer().notNull(),
  image_url: text().notNull(),
}, (table) => ({
  constraints: [
    primaryKey([table.item_id, table.row_index, table.image_group, table.image_index]),
    foreignKey([table.item_id, table.row_index], {
      table: "thread_command_detail_rows",
      columns: ["item_id", "row_index"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadCommandDetailImagesHistory = initialHistory(threadCommandDetailImagesV1);
export const threadCommandDetailImages = threadCommandDetailImagesHistory.current;

const threadOperationBrowsePresentationsV1 = defineTable("thread_operation_browse_presentations", {
  item_id: text().primaryKey(),
  presentation_type: enumText("browse").notNull().default("browse"),
  presentation_revision: integer().notNull(),
  action: enumText("run", "raw", "sessions", "stop", "forget").notNull(),
  session_name: text(),
  script_path: text(),
  requested_summary: text(),
  raw_action: text(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.presentation_type, table.presentation_revision], {
    table: "thread_operation_presentations",
    columns: ["item_id", "presentation_type", "presentation_revision"],
    onDelete: "CASCADE",
  })],
}));
const threadOperationBrowsePresentationsHistory = initialHistory(threadOperationBrowsePresentationsV1);
export const threadOperationBrowsePresentations = threadOperationBrowsePresentationsHistory.current;

const threadBrowsePresentationCommandsV1 = defineTable("thread_browse_presentation_commands", {
  item_id: text().notNull().references("thread_operation_browse_presentations", "item_id", { onDelete: "CASCADE" }),
  command_index: integer().notNull(),
  command: text().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.command_index])],
}));
const threadBrowsePresentationCommandsHistory = initialHistory(threadBrowsePresentationCommandsV1);
export const threadBrowsePresentationCommands = threadBrowsePresentationCommandsHistory.current;

const threadOperationSkillPresentationsV1 = defineTable("thread_operation_skill_presentations", {
  item_id: text().primaryKey(),
  presentation_type: enumText("skill").notNull().default("skill"),
  presentation_revision: integer().notNull(),
  skill_name: text().notNull(),
  skill_path: text().notNull(),
  description: text().notNull(),
  content: text().notNull(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.presentation_type, table.presentation_revision], {
    table: "thread_operation_presentations",
    columns: ["item_id", "presentation_type", "presentation_revision"],
    onDelete: "CASCADE",
  })],
}));
const threadOperationSkillPresentationsHistory = initialHistory(threadOperationSkillPresentationsV1);
export const threadOperationSkillPresentations = threadOperationSkillPresentationsHistory.current;

const threadOperationSubagentTaskPresentationsV1 = defineTable("thread_operation_subagent_task_presentations", {
  item_id: text().primaryKey(),
  presentation_type: enumText("subagentTask").notNull().default("subagentTask"),
  presentation_revision: integer().notNull(),
  label: text().notNull(),
  description: text().notNull(),
  agent_description: text().notNull(),
  prompt: text().notNull(),
  response_markdown: text(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.presentation_type, table.presentation_revision], {
    table: "thread_operation_presentations",
    columns: ["item_id", "presentation_type", "presentation_revision"],
    onDelete: "CASCADE",
  })],
}));
const threadOperationSubagentTaskPresentationsHistory = initialHistory(threadOperationSubagentTaskPresentationsV1);
export const threadOperationSubagentTaskPresentations = threadOperationSubagentTaskPresentationsHistory.current;

const threadOperationGitArcPresentationsV1 = defineTable("thread_operation_git_arc_presentations", {
  item_id: text().primaryKey(),
  presentation_type: enumText("gitArc").notNull().default("gitArc"),
  presentation_revision: integer().notNull(),
  action: enumText(
    "add", "adopt", "compare", "continue", "diff", "mv", "plan", "planAdd", "planAdopt", "planRemove",
    "planStart", "propose", "remove", "rescind", "restore", "start",
  ).notNull(),
  intent_name: text(),
  ref: text(),
  proposal_id: text(),
  proposal_title: text(),
  proposal_description: text(),
  amend: booleanInteger(),
  move_kind: enumText("operands", "maps", "regex"),
  move_pattern: text(),
  move_replacement: text(),
  move_confirm: booleanInteger(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.presentation_type, table.presentation_revision], {
    table: "thread_operation_presentations",
    columns: ["item_id", "presentation_type", "presentation_revision"],
    onDelete: "CASCADE",
  })],
}));
const threadOperationGitArcPresentationsV2 = evolveTable(threadOperationGitArcPresentationsV1, {
  add: {
    action: enumText(
      "add", "adopt", "compare", "continue", "diff", "mv", "plan", "planAdd", "planAdopt", "planRemove",
      "planStart", "propose", "release", "remove", "rescind", "restore", "start",
    ).notNull(),
    disown: booleanInteger().notNull().default(0),
  },
  drop: ["action"],
});
const threadOperationGitArcPresentationsHistory = defineTableHistory({
  versions: [
    tableVersion({ schemaVersion: 1, table: threadOperationGitArcPresentationsV1, migration: createTable(threadOperationGitArcPresentationsV1) }),
    tableVersion({
      schemaVersion: 2,
      table: threadOperationGitArcPresentationsV2,
      migration: rebuildTable({ from: threadOperationGitArcPresentationsV1, to: threadOperationGitArcPresentationsV2 }),
    }),
  ],
  current: threadOperationGitArcPresentationsV2,
});
export const threadOperationGitArcPresentations = threadOperationGitArcPresentationsHistory.current;

const threadGitArcPathsV1 = defineTable("thread_git_arc_paths", {
  item_id: text().notNull().references("thread_operation_git_arc_presentations", "item_id", { onDelete: "CASCADE" }),
  path_role: enumText("path", "adopt").notNull(),
  path_index: integer().notNull(),
  path: text().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.path_role, table.path_index])],
}));
const threadGitArcPathsHistory = initialHistory(threadGitArcPathsV1);
export const threadGitArcPaths = threadGitArcPathsHistory.current;

const threadGitArcMoveOperandsV1 = defineTable("thread_git_arc_move_operands", {
  item_id: text().notNull().references("thread_operation_git_arc_presentations", "item_id", { onDelete: "CASCADE" }),
  operand_index: integer().notNull(),
  operand: text().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.operand_index])],
}));
const threadGitArcMoveOperandsHistory = initialHistory(threadGitArcMoveOperandsV1);
export const threadGitArcMoveOperands = threadGitArcMoveOperandsHistory.current;

const threadGitArcMoveMappingsV1 = defineTable("thread_git_arc_move_mappings", {
  item_id: text().notNull().references("thread_operation_git_arc_presentations", "item_id", { onDelete: "CASCADE" }),
  mapping_index: integer().notNull(),
  source: text().notNull(),
  destination: text().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.mapping_index])],
}));
const threadGitArcMoveMappingsHistory = initialHistory(threadGitArcMoveMappingsV1);
export const threadGitArcMoveMappings = threadGitArcMoveMappingsHistory.current;

const threadGitArcMoveRegexRootsV1 = defineTable("thread_git_arc_move_regex_roots", {
  item_id: text().notNull().references("thread_operation_git_arc_presentations", "item_id", { onDelete: "CASCADE" }),
  root_index: integer().notNull(),
  root: text().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.root_index])],
}));
const threadGitArcMoveRegexRootsHistory = initialHistory(threadGitArcMoveRegexRootsV1);
export const threadGitArcMoveRegexRoots = threadGitArcMoveRegexRootsHistory.current;

const threadOperationSubagentPresentationsV1 = defineTable("thread_operation_subagent_presentations", {
  item_id: text().primaryKey(),
  presentation_type: enumText("subagent").notNull().default("subagent"),
  presentation_revision: integer().notNull(),
  action: enumText("create", "message", "settle", "stop", "wait").notNull(),
  message: text(),
  name: text(),
  profile_id: text(),
  title: text(),
  to_parent: booleanInteger().notNull(),
}, (table) => ({
  constraints: [foreignKey([table.item_id, table.presentation_type, table.presentation_revision], {
    table: "thread_operation_presentations",
    columns: ["item_id", "presentation_type", "presentation_revision"],
    onDelete: "CASCADE",
  })],
}));
const threadOperationSubagentPresentationsHistory = initialHistory(threadOperationSubagentPresentationsV1);
export const threadOperationSubagentPresentations = threadOperationSubagentPresentationsHistory.current;

const threadSubagentTargetsV1 = defineTable("thread_subagent_targets", {
  item_id: text().notNull().references("thread_operation_subagent_presentations", "item_id", { onDelete: "CASCADE" }),
  target_index: integer().notNull(),
  target_kind: enumText("id", "name").notNull(),
  target_value: text().notNull(),
}, (table) => ({
  constraints: [primaryKey([table.item_id, table.target_index])],
}));
const threadSubagentTargetsHistory = initialHistory(threadSubagentTargetsV1);
export const threadSubagentTargets = threadSubagentTargetsHistory.current;

const threadOperationThreadControlPresentationsV1 = defineTable("thread_operation_thread_control_presentations", {
  item_id: text().primaryKey(),
  presentation_type: enumText("threadControl").notNull().default("threadControl"),
  presentation_revision: integer().notNull(),
  action: enumText("recall", "status", "title").notNull(),
  status: enumText("blocked", "completed"),
  title: text(),
}, (table) => ({
  constraints: [
    check(sql`
      (${table.action} = ${literal("recall")} AND ${table.status} IS NULL AND ${table.title} IS NULL)
      OR (${table.action} = ${literal("status")} AND ${table.status} IS NOT NULL AND ${table.title} IS NULL)
      OR (${table.action} = ${literal("title")} AND ${table.status} IS NULL AND ${table.title} IS NOT NULL)
    `),
    foreignKey([table.item_id, table.presentation_type, table.presentation_revision], {
      table: "thread_operation_presentations",
      columns: ["item_id", "presentation_type", "presentation_revision"],
      onDelete: "CASCADE",
    }),
  ],
}));
const threadOperationThreadControlPresentationsHistory = initialHistory(threadOperationThreadControlPresentationsV1);
export const threadOperationThreadControlPresentations = threadOperationThreadControlPresentationsHistory.current;

export const operationPresentationTables = Object.freeze({
  threadOperationPresentations,
  threadOperationCommandPresentations,
  threadCommandSummaryParts,
  threadCommandDetailRows,
  threadCommandDetailSummaryParts,
  threadCommandDetailImages,
  threadOperationBrowsePresentations,
  threadBrowsePresentationCommands,
  threadOperationSkillPresentations,
  threadOperationSubagentTaskPresentations,
  threadOperationGitArcPresentations,
  threadGitArcPaths,
  threadGitArcMoveOperands,
  threadGitArcMoveMappings,
  threadGitArcMoveRegexRoots,
  threadOperationSubagentPresentations,
  threadSubagentTargets,
  threadOperationThreadControlPresentations,
});

export type OperationPresentationSchemaRows = {
  [Name in keyof typeof operationPresentationTables]: SelectRow<(typeof operationPresentationTables)[Name]>;
};

export const operationPresentationSchemaHistory = defineSubsystemHistory([
  threadOperationPresentationsHistory,
  threadOperationCommandPresentationsHistory,
  threadCommandSummaryPartsHistory,
  threadCommandDetailRowsHistory,
  threadCommandDetailSummaryPartsHistory,
  threadCommandDetailImagesHistory,
  threadOperationBrowsePresentationsHistory,
  threadBrowsePresentationCommandsHistory,
  threadOperationSkillPresentationsHistory,
  threadOperationSubagentTaskPresentationsHistory,
  threadOperationGitArcPresentationsHistory,
  threadGitArcPathsHistory,
  threadGitArcMoveOperandsHistory,
  threadGitArcMoveMappingsHistory,
  threadGitArcMoveRegexRootsHistory,
  threadOperationSubagentPresentationsHistory,
  threadSubagentTargetsHistory,
  threadOperationThreadControlPresentationsHistory,
]);
