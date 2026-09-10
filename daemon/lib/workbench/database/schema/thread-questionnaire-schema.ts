/*
 * Exports:
 * - defineThreadQuestionnaireSchema: preserve questionnaire source facts outside transcript materialisation.
 */
import {
  booleanInteger, check, defineTable, enumText, foreignKey, index, integer, literal,
  primaryKey, sql, text, unique, type TableDefinition,
} from "workbench-shared/database/schema/schema-definition";
import {
  createTable, defineSubsystemHistory, defineTableHistory, tableVersion,
} from "workbench-shared/database/schema/schema-history";

export function defineThreadQuestionnaireSchema(schemaVersion: number) {
  function install<Table extends TableDefinition>(table: Table) {
    return defineTableHistory({
      current: table,
      versions: [tableVersion({ schemaVersion, table, migration: createTable(table) })],
    });
  }

  const questionnaires = install(defineTable("workbench_thread_questionnaires", {
    id: text().primaryKey(),
    thread_id: text().notNull().references("workbench_thread_states", "thread_id", { onDelete: "CASCADE" }),
    state: enumText("pending", "answered").notNull(),
    turn_id: text(),
    item_id: text(),
    request_key: text().notNull(),
    request_id: text().notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    submit_label: text().notNull(),
    insert_after_item_id: text(),
    insert_after_item_index: integer().nonNegative(),
    resolved_at: integer().nonNegative(),
    history_index: integer().nonNegative(),
  }, (table) => ({
    constraints: [
      unique([table.id, table.state]),
      unique([table.thread_id, table.history_index]),
      foreignKey([table.turn_id, table.thread_id], {
        table: "thread_turns", columns: ["id", "thread_id"],
      }),
      foreignKey([table.item_id, table.thread_id], {
        table: "workbench_transcript_item_identities", columns: ["id", "thread_id"],
      }),
      foreignKey([table.insert_after_item_id, table.thread_id], {
        table: "workbench_transcript_item_identities", columns: ["id", "thread_id"],
      }),
      check(sql`(${table.state} = ${literal("pending")} AND ${table.insert_after_item_id} IS NULL AND ${table.insert_after_item_index} IS NULL AND ${table.resolved_at} IS NULL AND ${table.history_index} IS NULL) OR (${table.state} = ${literal("answered")} AND ${table.turn_id} IS NOT NULL AND ${table.resolved_at} IS NOT NULL AND ${table.history_index} IS NOT NULL)`),
    ],
    indexes: [index("workbench_thread_questionnaires_pending_idx", [table.thread_id], {
      unique: true, where: sql`${table.state} = ${literal("pending")}`,
    })],
  })));

  const questions = install(defineTable("workbench_thread_questionnaire_questions", {
    questionnaire_id: text().notNull().references("workbench_thread_questionnaires", "id", { onDelete: "CASCADE" }),
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
  })));

  const options = install(defineTable("workbench_thread_questionnaire_options", {
    questionnaire_id: text().notNull(),
    question_index: integer().notNull().nonNegative(),
    option_index: integer().notNull().nonNegative(),
    label: text().notNull(),
    description: text().notNull(),
  }, (table) => ({
    constraints: [
      primaryKey([table.questionnaire_id, table.question_index, table.option_index]),
      foreignKey([table.questionnaire_id, table.question_index], {
        table: "workbench_thread_questionnaire_questions", columns: ["questionnaire_id", "question_index"], onDelete: "CASCADE",
      }),
    ],
  })));

  const answerGroups = install(defineTable("workbench_thread_questionnaire_answer_groups", {
    questionnaire_id: text().notNull(),
    questionnaire_state: enumText("answered").notNull(),
    question_id: text().notNull(),
  }, (table) => ({
    constraints: [
      primaryKey([table.questionnaire_id, table.question_id]),
      foreignKey([table.questionnaire_id, table.questionnaire_state], {
        table: "workbench_thread_questionnaires", columns: ["id", "state"], onDelete: "CASCADE",
      }),
    ],
  })));

  const answers = install(defineTable("workbench_thread_questionnaire_answers", {
    questionnaire_id: text().notNull(),
    question_id: text().notNull(),
    answer_index: integer().notNull().nonNegative(),
    answer: text().notNull(),
  }, (table) => ({
    constraints: [
      primaryKey([table.questionnaire_id, table.question_id, table.answer_index]),
      foreignKey([table.questionnaire_id, table.question_id], {
        table: "workbench_thread_questionnaire_answer_groups", columns: ["questionnaire_id", "question_id"], onDelete: "CASCADE",
      }),
    ],
  })));

  return {
    tables: {
      questionnaires: questionnaires.current, questions: questions.current, options: options.current,
      answerGroups: answerGroups.current, answers: answers.current,
    },
    history: defineSubsystemHistory([questionnaires, questions, options, answerGroups, answers]),
  };
}
