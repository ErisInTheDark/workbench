/*
 * transformCoreTranscriptItem: convert visible message, reasoning, plan, file-change, compaction, and unknown items to relational mutations. Keywords: transcript, transform, canonical item.
 */
import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem.ts";
import type { WorkbenchFileChangeItem } from "../../../lib/workbench/thread/workbench-file-change.ts";
import { itemTables } from "../workbench-database-schema.ts";
import {
  deleteRows,
  insertRow,
  upsertRow,
  type WorkbenchDatabaseMutation,
} from "../workbench-database-statements.ts";
import type {
  WorkbenchTranscriptItemTransform,
  WorkbenchTranscriptItemTransformContext,
} from "./workbench-transcript-transform-registry.ts";

function itemLifecycleState(lifecycle: WorkbenchTranscriptItemTransformContext["lifecycle"]) {
  return lifecycle;
}

function childCleanup(itemId: string, table: Parameters<typeof deleteRows>[0]) {
  return deleteRows(table, { item_id: itemId });
}

function unknownItem(item: ThreadItem | WorkbenchFileChangeItem): WorkbenchTranscriptItemTransform {
  return {
    itemType: "unknown",
    cleanup: [],
    mutations: [
      upsertRow(itemTables.threadItemUnknown, {
        item_id: item.id,
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
  { item, lifecycle }: WorkbenchTranscriptItemTransformContext,
): WorkbenchTranscriptItemTransform | null {
  if (item.type === "userMessage") {
    if (item.content.some((part) => part.type === "audio" || part.type === "localAudio")) return unknownItem(item);
    const parts: WorkbenchDatabaseMutation[] = item.content.map((part, partIndex) => {
      if (part.type === "text") {
        return insertRow(itemTables.threadUserMessageParts, {
          item_id: item.id,
          part_index: partIndex,
          part_type: "text",
          text: part.text,
        });
      }
      if (part.type === "image") {
        return insertRow(itemTables.threadUserMessageParts, {
          item_id: item.id,
          part_index: partIndex,
          part_type: "image",
          url: part.url,
          image_detail: part.detail ?? null,
        });
      }
      if (part.type === "localImage") {
        return insertRow(itemTables.threadUserMessageParts, {
          item_id: item.id,
          part_index: partIndex,
          part_type: "localImage",
          path: part.path,
          image_detail: part.detail ?? null,
        });
      }
      if (part.type === "skill" || part.type === "mention") {
        return insertRow(itemTables.threadUserMessageParts, {
          item_id: item.id,
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
      cleanup: [childCleanup(item.id, itemTables.threadUserMessageParts)],
      mutations: [
        upsertRow(itemTables.threadItemUserMessages, {
          item_id: item.id,
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
          item_id: item.id,
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

  if (item.type === "plan") {
    return {
      itemType: "plan",
      cleanup: [],
      mutations: [
        upsertRow(itemTables.threadItemPlans, {
          item_id: item.id,
          text: item.text,
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["text"],
        }),
      ],
    };
  }

  if (item.type === "reasoning") {
    const visibleSections = item.summary.some((section) => section.trim()) ? item.summary : item.content;
    return {
      itemType: "reasoning",
      cleanup: [childCleanup(item.id, itemTables.threadReasoningSections)],
      mutations: [
        upsertRow(itemTables.threadItemReasoning, {
          item_id: item.id,
          state: itemLifecycleState(lifecycle),
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["state"],
        }),
        ...visibleSections.map((text, sectionIndex) => insertRow(itemTables.threadReasoningSections, {
          item_id: item.id,
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
      cleanup: [childCleanup(item.id, itemTables.threadFileChanges)],
      mutations: [
        upsertRow(itemTables.threadItemFileChanges, {
          item_id: item.id,
          state: item.status,
          error_text: null,
          workbench_failure_kind: workbenchItem.workbenchFailureKind ?? null,
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["state", "error_text", "workbench_failure_kind"],
        }),
        ...workbenchItem.changes.map((change, changeIndex) => insertRow(itemTables.threadFileChanges, {
          item_id: item.id,
          change_index: changeIndex,
          path: change.path,
          change_kind: change.kind.type,
          diff: change.diff,
          move_path: change.kind.type === "update" ? change.kind.move_path : null,
          workbench_additions: change.workbenchAdditions ?? null,
          workbench_deletions: change.workbenchDeletions ?? null,
        })),
      ],
    };
  }

  if (item.type === "contextCompaction") {
    return {
      itemType: "contextCompaction",
      cleanup: [],
      mutations: [
        upsertRow(itemTables.threadItemContextCompactions, {
          item_id: item.id,
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
    "hookPrompt",
    "subAgentActivity",
    "imageView",
    "sleep",
    "imageGeneration",
    "enteredReviewMode",
    "exitedReviewMode",
  ]);
  return coreUnsupported.has(item.type) ? unknownItem(item) : null;
}
