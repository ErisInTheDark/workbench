/*
 * transformInteractionTranscriptItem: convert provider web-search items to typed relational rows. Keywords: transcript, transform, web search.
 * transformQuestionnaireEntry: convert one settled Workbench interaction to typed relational rows. Keywords: transcript, questionnaire, approval.
 * transformSteerEntry: convert one settled Workbench steer to a canonical user-message row. Keywords: transcript, steer, user message.
 */
import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem.ts";
import { resolveQuestionnaireHistoryItemId } from "../../../lib/workbench/thread/thread-questionnaire-identity.ts";
import { createSyntheticSteerHistoryItemId } from "../../../lib/workbench/thread/thread-steer-history.ts";
import type {
  WorkbenchQuestionnaireHistoryEntry,
  WorkbenchSteerHistoryEntry,
} from "../../../lib/types.ts";
import { interactionTables, itemTables } from "../workbench-database-schema.ts";
import {
  deleteRows,
  insertRow,
  upsertRow,
  type WorkbenchDatabaseMutation,
} from "workbench-shared/database/workbench-database-statements";
import type {
  WorkbenchTranscriptItemTransform,
  WorkbenchTranscriptItemTransformContext,
} from "./workbench-transcript-transform-registry.ts";

export interface WorkbenchInteractionTransform extends WorkbenchTranscriptItemTransform {
  itemId: string;
}

function actionFields(action: Extract<ThreadItem, { type: "webSearch" }>["action"]) {
  if (!action) return { action_kind: "none" as const };
  if (action.type === "search") {
    return {
      action_kind: "search" as const,
      action_query: action.query,
    };
  }
  if (action.type === "openPage") {
    return {
      action_kind: "openPage" as const,
      url: action.url,
    };
  }
  if (action.type === "findInPage") {
    return {
      action_kind: "findInPage" as const,
      url: action.url,
      pattern: action.pattern,
    };
  }
  return { action_kind: "other" as const };
}

export function transformInteractionTranscriptItem(
  { item, lifecycle }: WorkbenchTranscriptItemTransformContext,
): WorkbenchTranscriptItemTransform | null {
  if (item.type !== "webSearch") return null;
  const queries = item.action?.type === "search"
    ? item.action.queries ?? (item.action.query ? [item.action.query] : [])
    : [];
  return {
    itemType: "webSearch",
    cleanup: [
      deleteRows(interactionTables.threadWebSearchQueries, { item_id: item.id }),
      deleteRows(interactionTables.threadWebSearchResults, { item_id: item.id }),
    ],
    mutations: [
      upsertRow(interactionTables.threadItemWebSearches, {
        item_id: item.id,
        state: lifecycle === "streaming" ? "inProgress" : lifecycle === "completed" ? "completed" : "failed",
        query: item.query,
        ...actionFields(item.action),
        error_text: null,
      }, {
        conflictColumns: ["item_id"],
        updateColumns: ["state", "query", "action_kind", "action_query", "url", "pattern", "error_text"],
      }),
      ...queries.map((query, queryIndex) => insertRow(interactionTables.threadWebSearchQueries, {
        item_id: item.id,
        query_index: queryIndex,
        query,
      })),
      ...(item.results ?? []).map((result, resultIndex) => insertRow(interactionTables.threadWebSearchResults, {
        item_id: item.id,
        result_index: resultIndex,
        opaque_json: JSON.stringify(result),
      })),
    ],
  };
}

export function transformQuestionnaireEntry(
  entry: WorkbenchQuestionnaireHistoryEntry,
): WorkbenchInteractionTransform {
  const itemId = resolveQuestionnaireHistoryItemId(entry);
  const command = entry.request.approval?.command;
  const itemType = command ? "approval" : "questionnaire";
  const mutations: WorkbenchDatabaseMutation[] = [
    upsertRow(interactionTables.threadItemInteractions, {
      item_id: itemId,
      item_type: itemType,
      thread_id: entry.threadId,
      request_key: entry.requestKey,
      request_id: entry.request.id,
      title: entry.request.title,
      summary: entry.request.summary,
      submit_label: entry.request.submitLabel,
      state: "answered",
      error_text: null,
      resolved_at: entry.resolvedAt,
    }, {
      conflictColumns: ["item_id"],
      updateColumns: [
        "item_type",
        "request_key",
        "request_id",
        "title",
        "summary",
        "submit_label",
        "state",
        "error_text",
        "resolved_at",
      ],
    }),
  ];
  for (const [questionIndex, question] of entry.request.questions.entries()) {
    mutations.push(insertRow(interactionTables.threadInteractionQuestions, {
      item_id: itemId,
      question_index: questionIndex,
      question_id: question.id,
      header: question.header,
      question: question.question,
      allow_other: question.allowOther ? 1 : 0,
      is_secret: question.isSecret ? 1 : 0,
    }));
    for (const [optionIndex, option] of question.options.entries()) {
      mutations.push(insertRow(interactionTables.threadInteractionOptions, {
        item_id: itemId,
        question_index: questionIndex,
        option_index: optionIndex,
        label: option.label,
        description: option.description,
      }));
    }
    const answer = entry.response.answers[question.id];
    for (const [answerIndex, value] of (answer?.answers ?? []).entries()) {
      mutations.push(insertRow(interactionTables.threadInteractionAnswers, {
        item_id: itemId,
        question_id: question.id,
        answer_index: answerIndex,
        answer: value,
      }));
    }
  }
  if (command) {
    mutations.push(upsertRow(interactionTables.threadApprovalCommandContexts, {
      item_id: itemId,
      command: command.command,
      cwd: command.cwd,
    }, {
      conflictColumns: ["item_id"],
      updateColumns: ["command", "cwd"],
    }));
    for (const [actionIndex, action] of command.commandActions.entries()) {
      mutations.push(insertRow(interactionTables.threadApprovalCommandActions, {
        item_id: itemId,
        action_index: actionIndex,
        action_kind: action.type,
        command: action.command,
        name: action.type === "read" ? action.name : null,
        path: action.type === "read" || action.type === "listFiles" || action.type === "search"
          ? action.path
          : null,
        query: action.type === "search" ? action.query : null,
      }));
    }
  }
  return {
    itemId,
    itemType,
    cleanup: [
      deleteRows(interactionTables.threadInteractionAnswers, { item_id: itemId }),
      deleteRows(interactionTables.threadInteractionOptions, { item_id: itemId }),
      deleteRows(interactionTables.threadInteractionQuestions, { item_id: itemId }),
      deleteRows(interactionTables.threadApprovalCommandActions, { item_id: itemId }),
    ],
    mutations,
  };
}

export function transformSteerEntry(entry: WorkbenchSteerHistoryEntry): WorkbenchInteractionTransform | null {
  if (entry.status === "pending") return null;
  const itemId = entry.status === "sent"
    ? entry.canonicalItemId ?? entry.clientUserMessageId ?? `workbench-steer:${entry.threadId}:${entry.entryKey}`
    : createSyntheticSteerHistoryItemId(entry);
  if (entry.input.some((part) => part.type === "audio" || part.type === "localAudio")) {
    return {
      itemId,
      itemType: "unknown",
      cleanup: [],
      mutations: [
        upsertRow(itemTables.threadItemUnknown, {
          item_id: itemId,
          native_type: "workbenchSteer",
          safe_json: JSON.stringify(entry),
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["native_type", "safe_json"],
        }),
      ],
    };
  }
  return {
    itemId,
    itemType: "userMessage",
    cleanup: [deleteRows(itemTables.threadUserMessageParts, { item_id: itemId })],
    mutations: [
      upsertRow(itemTables.threadItemUserMessages, {
        item_id: itemId,
        delivery_state: entry.status === "sent" ? "delivered" : entry.status,
        client_id: entry.clientUserMessageId ?? null,
        error_text: entry.status === "failed" ? entry.error ?? "Steer delivery failed." : null,
      }, {
        conflictColumns: ["item_id"],
        updateColumns: ["delivery_state", "client_id", "error_text"],
      }),
      ...entry.input.map((part, partIndex) => {
        if (part.type === "text") {
          return insertRow(itemTables.threadUserMessageParts, {
            item_id: itemId,
            part_index: partIndex,
            part_type: "text",
            text: part.text,
          });
        }
        if (part.type === "image") {
          return insertRow(itemTables.threadUserMessageParts, {
            item_id: itemId,
            part_index: partIndex,
            part_type: "image",
            url: part.url,
            image_detail: part.detail ?? null,
          });
        }
        if (part.type === "localImage") {
          return insertRow(itemTables.threadUserMessageParts, {
            item_id: itemId,
            part_index: partIndex,
            part_type: "localImage",
            path: part.path,
            image_detail: part.detail ?? null,
          });
        }
        if (part.type === "skill" || part.type === "mention") {
          return insertRow(itemTables.threadUserMessageParts, {
            item_id: itemId,
            part_index: partIndex,
            part_type: part.type,
            path: part.path,
            name: part.name,
          });
        }
        throw new Error(`Unsupported visible steer part: ${part.type}`);
      }),
    ],
  };
}
