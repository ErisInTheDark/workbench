/*
 * Keywords: thread state, questionnaire, identity.
 * Exports:
 * - projectThreadStateQuestionnaires: project questionnaires using admitted item identities.
 */
import type { WorkbenchDurableQuestionnaire } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadStateRecord } from "../../workbench-thread-state-record.ts";
import {
  ANSWER_TABLE,
  OPTION_TABLE,
  QUESTIONNAIRE_TABLE,
  QUESTION_TABLE,
  addRow,
  type RowSets,
} from "./workbench-thread-state-relational-tables.ts";

export function projectThreadStateQuestionnaires(
  rows: RowSets,
  threadId: string,
  record: WorkbenchThreadStateRecord,
  resolveIdentity: (entry: WorkbenchDurableQuestionnaire) => { id: string; legacyId: string | null },
) {
  const entries = [
    ...(record.pendingQuestionnaire ? [{
      entry: record.pendingQuestionnaire,
      state: "pending" as const,
      response: null,
      resolvedAt: null,
      insertAfterItemId: null,
      insertAfterItemIndex: null,
    }] : []),
    ...(record.questionnaireHistory ?? []).map((entry) => ({
      entry,
      state: "answered" as const,
      response: entry.response,
      resolvedAt: entry.resolvedAt,
      insertAfterItemId: entry.insertAfterItemId,
      insertAfterItemIndex: entry.insertAfterItemIndex,
    })),
  ];
  for (const value of entries) {
    const request = value.entry.request;
    const providerTurnId = value.entry.turnId;
    const providerItemId = value.entry.itemId;
    const { id, legacyId } = resolveIdentity(value.entry);
    addRow(rows, QUESTIONNAIRE_TABLE, {
      id,
      legacy_id: legacyId,
      thread_id: threadId,
      state: value.state,
      provider_turn_id: providerTurnId,
      provider_item_id: providerItemId,
      request_key: value.entry.requestKey,
      request_id: request.id,
      title: request.title,
      summary: request.summary,
      submit_label: request.submitLabel,
      insert_after_item_id: value.insertAfterItemId,
      insert_after_item_index: value.insertAfterItemIndex,
      resolved_at: value.resolvedAt,
    });
    request.questions.forEach((question, questionIndex) => {
      addRow(rows, QUESTION_TABLE, {
        questionnaire_id: id,
        question_index: questionIndex,
        question_id: question.id,
        header: question.header,
        question: question.question,
        allow_other: question.allowOther ? 1 : 0,
        is_secret: question.isSecret ? 1 : 0,
      });
      question.options.forEach((option, optionIndex) => addRow(rows, OPTION_TABLE, {
        questionnaire_id: id,
        question_index: questionIndex,
        option_index: optionIndex,
        label: option.label,
        description: option.description,
      }));
      for (const [answerIndex, answer] of (value.response?.answers[question.id]?.answers ?? []).entries()) {
        addRow(rows, ANSWER_TABLE, {
          questionnaire_id: id,
          questionnaire_state: "answered",
          question_id: question.id,
          answer_index: answerIndex,
          answer,
        });
      }
    });
  }
}
