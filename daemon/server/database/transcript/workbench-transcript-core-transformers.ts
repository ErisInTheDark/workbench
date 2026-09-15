/*
 * Exports:
 * - transformCoreTranscriptItem: convert core transcript items to relational mutations.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import { itemTables } from "../workbench-database-schema.ts";
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

function itemLifecycleState(lifecycle: WorkbenchTranscriptItemTransformContext["lifecycle"]) {
  return lifecycle;
}

function childCleanup(itemId: number, table: Parameters<typeof deleteRows>[0]) {
  return deleteRows(table, { item_id: itemId });
}

function unknownItem(
  item: ThreadItem | WorkbenchFileChangeItem,
  itemId: number,
): WorkbenchTranscriptItemTransform {
  return {
    itemType: "unknown",
    cleanup: [],
    mutations: [
      upsertRow(itemTables.threadItemUnknown, {
        item_id: itemId,
        native_type: item.type,
        safe_json: JSON.stringify(item),
      }, {
        conflictColumns: ["item_id"],
        updateColumns: ["native_type", "safe_json"],
      }),
    ],
  };
}

export function transformCoreTranscriptItem(
  { item, itemId, lifecycle }: WorkbenchTranscriptItemTransformContext,
): WorkbenchTranscriptItemTransform | null {
  if (item.type === "userMessage") {
    if (item.content.some((part) => part.type === "audio" || part.type === "localAudio")) return unknownItem(item, itemId);
    const parts: WorkbenchDatabaseMutation[] = item.content.map((part, partIndex) => {
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
      throw new Error(`Unsupported visible user-message part: ${part.type}`);
    });
    return {
      itemType: "userMessage",
      cleanup: [childCleanup(itemId, itemTables.threadUserMessageParts)],
      mutations: [
        upsertRow(itemTables.threadItemUserMessages, {
          item_id: itemId,
          delivery_state: lifecycle === "interrupted" ? "interrupted" : "delivered",
          client_id: item.clientId,
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["delivery_state", "client_id", "error_text"],
        }),
        ...parts,
      ],
    };
  }

  if (item.type === "agentMessage") {
    return {
      itemType: "assistantMessage",
      cleanup: [],
      mutations: [
        upsertRow(itemTables.threadItemAssistantMessages, {
          item_id: itemId,
          state: itemLifecycleState(lifecycle),
          phase: item.phase === "final_answer" ? "finalAnswer" : item.phase ?? "unknown",
          text: item.text,
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["state", "phase", "text"],
        }),
      ],
    };
  }

  if (item.type === "reasoning") {
    const visibleSections = item.summary.some((section) => section.trim()) ? item.summary : item.content;
    return {
      itemType: "reasoning",
      cleanup: [childCleanup(itemId, itemTables.threadReasoningSections)],
      mutations: [
        upsertRow(itemTables.threadItemReasoning, {
          item_id: itemId,
          state: itemLifecycleState(lifecycle),
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["state"],
        }),
        ...visibleSections.map((text, sectionIndex) => insertRow(itemTables.threadReasoningSections, {
          item_id: itemId,
          section_index: sectionIndex,
          text,
        })),
      ],
    };
  }

  if (item.type === "fileChange") {
    const workbenchItem = item as WorkbenchFileChangeItem;
    return {
      itemType: "fileChange",
      cleanup: [childCleanup(itemId, itemTables.threadFileChanges)],
      mutations: [
        upsertRow(itemTables.threadItemFileChanges, {
          item_id: itemId,
          state: item.status,
          error_text: null,
          workbench_failure_kind: workbenchItem.workbenchFailureKind ?? null,
          workbench_policy: workbenchItem.workbenchPolicy ?? null,
          recovery_state: workbenchItem.workbenchRecovery?.state ?? null,
          recovery_detail: workbenchItem.workbenchRecovery?.detail ?? null,
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["state", "error_text", "workbench_failure_kind", "workbench_policy", "recovery_state", "recovery_detail"],
        }),
        ...workbenchItem.changes.map((change, changeIndex) => insertRow(itemTables.threadFileChanges, {
          item_id: itemId,
          change_index: changeIndex,
          path: change.path,
          change_kind: change.kind.type,
          diff: change.diff,
          move_path: change.kind.type === "update" ? change.kind.move_path : null,
          workbench_additions: change.workbenchAdditions ?? null,
          workbench_deletions: change.workbenchDeletions ?? null,
          analysis_outcome: change.workbenchAnalysis?.outcome ?? null,
          analysis_detail: change.workbenchAnalysis?.detail ?? null,
          analysis_additions: change.workbenchAnalysis?.additions ?? null,
          analysis_deletions: change.workbenchAnalysis?.deletions ?? null,
        })),
        ...workbenchItem.changes.flatMap((change, changeIndex) => (change.workbenchAnalysis?.hunks ?? []).flatMap((hunk) => [
          insertRow(itemTables.threadFileChangeHunks, {
            item_id: itemId, change_index: changeIndex, hunk_index: hunk.index,
            outcome: hunk.outcome, reason: hunk.reason, additions: hunk.additions, deletions: hunk.deletions,
            current_start: hunk.currentStart, current_end: hunk.currentEnd, old_start: hunk.oldStart, new_start: hunk.newStart,
          }),
          ...hunk.candidates.map((line, candidateIndex) => insertRow(itemTables.threadFileChangeCandidates, {
            item_id: itemId, change_index: changeIndex, hunk_index: hunk.index, candidate_index: candidateIndex, current_line: line,
          })),
        ])),
      ],
    };
  }

  if (item.type === "contextCompaction") {
    return {
      itemType: "contextCompaction",
      cleanup: [],
      mutations: [
        upsertRow(itemTables.threadItemContextCompactions, {
          item_id: itemId,
          state: lifecycle === "streaming" ? "inProgress" : lifecycle === "completed" ? "completed" : "failed",
          error_text: lifecycle === "interrupted" ? "Context compaction was interrupted." : null,
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["state", "error_text"],
        }),
      ],
    };
  }

  const coreUnsupported = new Set<ThreadItem["type"]>([
    "functionCallOutput",
    "hookPrompt",
    "subAgentActivity",
    "imageView",
    "sleep",
    "imageGeneration",
    "enteredReviewMode",
    "exitedReviewMode",
  ]);
  return coreUnsupported.has(item.type) ? unknownItem(item, itemId) : null;
}
