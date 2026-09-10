/*
 * Exports:
 * - default WorkbenchThreadStateQuestionnaireRepository: persist one thread's canonical questionnaire source facts.
 * - WorkbenchThreadQuestionnaires: pending request and ordered answered history.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  WorkbenchDurableQuestionnaireSchema, WorkbenchQuestionnaireHistoryEntrySchema,
  type WorkbenchDurableQuestionnaire, type WorkbenchQuestionnaireHistoryEntryState,
} from "workbench-shared/workbench/thread/thread-state";

export interface WorkbenchThreadQuestionnaires {
  pending: WorkbenchDurableQuestionnaire | null;
  history: WorkbenchQuestionnaireHistoryEntryState[];
}

type QuestionnaireRow = {
  id: string;
  thread_id: string;
  state: "pending" | "answered";
  turn_id: string | null;
  item_id: string | null;
  request_key: string;
  request_id: string;
  title: string;
  summary: string;
  submit_label: string;
  insert_after_item_id: string | null;
  insert_after_item_index: number | null;
  resolved_at: number | null;
  history_index: number | null;
};

export default class WorkbenchThreadStateQuestionnaireRepository {
  constructor(private readonly database: Database.Database) {}

  read(threadId: string): WorkbenchThreadQuestionnaires {
    const rows = this.database.prepare(`
      SELECT * FROM workbench_thread_questionnaires WHERE thread_id = ? ORDER BY history_index
    `).all(threadId) as QuestionnaireRow[];
    const result: WorkbenchThreadQuestionnaires = { pending: null, history: [] };
    for (const row of rows) {
      const request = this.readRequest(row);
      const common = {
        request, requestKey: row.request_key, turnId: row.turn_id, itemId: row.item_id,
      };
      if (row.state === "pending") {
        if (result.pending) throw new Error("Thread has multiple pending questionnaires.");
        result.pending = WorkbenchDurableQuestionnaireSchema.parse(common);
      } else {
        if (row.history_index !== result.history.length) throw new Error("Questionnaire history has incomplete ordering.");
        result.history.push(WorkbenchQuestionnaireHistoryEntrySchema.parse({
          ...common, threadId, resolvedAt: row.resolved_at,
          insertAfterItemId: row.insert_after_item_id, insertAfterItemIndex: row.insert_after_item_index,
          response: this.readResponse(row.id),
        }));
      }
    }
    return result;
  }

  replace(threadId: string, value: WorkbenchThreadQuestionnaires) {
    const pending = value.pending === null ? null : WorkbenchDurableQuestionnaireSchema.parse(value.pending);
    const history = value.history.map((entry) => WorkbenchQuestionnaireHistoryEntrySchema.parse(entry));
    if (history.some((entry) => entry.threadId !== threadId)) throw new Error("Questionnaire history belongs to another thread.");
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM workbench_thread_questionnaires WHERE thread_id = ?").run(threadId);
      if (pending) this.insert(threadId, pending, null);
      history.forEach((entry, historyIndex) => this.insert(threadId, entry, historyIndex));
    })();
  }

  private insert(threadId: string, entry: WorkbenchDurableQuestionnaire | WorkbenchQuestionnaireHistoryEntryState, historyIndex: number | null) {
    const answered = "response" in entry;
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO workbench_thread_questionnaires(
        id, thread_id, state, turn_id, item_id, request_key, request_id, title, summary, submit_label,
        insert_after_item_id, insert_after_item_index, resolved_at, history_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, threadId, answered ? "answered" : "pending", entry.turnId, entry.itemId, entry.requestKey,
      entry.request.id, entry.request.title, entry.request.summary, entry.request.submitLabel,
      answered ? entry.insertAfterItemId : null, answered ? entry.insertAfterItemIndex : null,
      answered ? entry.resolvedAt : null, historyIndex,
    );
    const questionStatement = this.database.prepare(`
      INSERT INTO workbench_thread_questionnaire_questions(
        questionnaire_id, question_index, question_id, header, question, allow_other, is_secret
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const optionStatement = this.database.prepare(`
      INSERT INTO workbench_thread_questionnaire_options(questionnaire_id, question_index, option_index, label, description)
      VALUES (?, ?, ?, ?, ?)
    `);
    entry.request.questions.forEach((question, questionIndex) => {
      questionStatement.run(id, questionIndex, question.id, question.header, question.question, Number(question.allowOther), Number(question.isSecret));
      question.options.forEach((option, optionIndex) => {
        optionStatement.run(id, questionIndex, optionIndex, option.label, option.description);
      });
    });
    if (!answered) return;
    const groupStatement = this.database.prepare(`
      INSERT INTO workbench_thread_questionnaire_answer_groups(questionnaire_id, questionnaire_state, question_id)
      VALUES (?, 'answered', ?)
    `);
    const answerStatement = this.database.prepare(`
      INSERT INTO workbench_thread_questionnaire_answers(questionnaire_id, question_id, answer_index, answer)
      VALUES (?, ?, ?, ?)
    `);
    for (const [questionId, group] of Object.entries(entry.response.answers)) {
      groupStatement.run(id, questionId);
      group.answers.forEach((answer, answerIndex) => answerStatement.run(id, questionId, answerIndex, answer));
    }
  }

  private readRequest(row: QuestionnaireRow): WorkbenchDurableQuestionnaire["request"] {
    const questions = this.database.prepare(`
      SELECT question_index, question_id, header, question, allow_other, is_secret
      FROM workbench_thread_questionnaire_questions WHERE questionnaire_id = ? ORDER BY question_index
    `).all(row.id) as Array<{
      question_index: number; question_id: string; header: string; question: string; allow_other: 0 | 1; is_secret: 0 | 1;
    }>;
    const options = this.database.prepare(`
      SELECT question_index, option_index, label, description
      FROM workbench_thread_questionnaire_options WHERE questionnaire_id = ? ORDER BY question_index, option_index
    `).all(row.id) as Array<{ question_index: number; option_index: number; label: string; description: string }>;
    return {
      id: row.request_id, title: row.title, summary: row.summary, submitLabel: row.submit_label,
      questions: questions.map((question, questionIndex) => {
        if (question.question_index !== questionIndex) throw new Error("Questionnaire has incomplete question ordering.");
        return {
          id: question.question_id, header: question.header, question: question.question,
          allowOther: Boolean(question.allow_other), isSecret: Boolean(question.is_secret),
          options: options.filter((option) => option.question_index === questionIndex).map((option, optionIndex) => {
            if (option.option_index !== optionIndex) throw new Error("Questionnaire has incomplete option ordering.");
            return { label: option.label, description: option.description };
          }),
        };
      }),
    };
  }

  private readResponse(id: string): WorkbenchQuestionnaireHistoryEntryState["response"] {
    const groups = this.database.prepare(`
      SELECT question_id FROM workbench_thread_questionnaire_answer_groups WHERE questionnaire_id = ?
    `).all(id) as Array<{ question_id: string }>;
    const rows = this.database.prepare(`
      SELECT question_id, answer_index, answer FROM workbench_thread_questionnaire_answers
      WHERE questionnaire_id = ? ORDER BY question_id, answer_index
    `).all(id) as Array<{ question_id: string; answer_index: number; answer: string }>;
    return {
      answers: Object.fromEntries(groups.map((group) => [
        group.question_id,
        { answers: rows.filter((row) => row.question_id === group.question_id).map((row, answerIndex) => {
          if (row.answer_index !== answerIndex) throw new Error("Questionnaire has incomplete answer ordering.");
          return row.answer;
        }) },
      ])),
    };
  }
}
