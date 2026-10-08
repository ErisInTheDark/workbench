/*
 * Exports:
 * - TranscriptSideEntries: questionnaire and steer history derived from one transcript snapshot.
 * - projectTranscriptSideEntries: derive them from projected turns plus the snapshot's input and held-steer rows.
 * - isTranscriptSideEntryItem: items that are history entries rather than visible turn content.
 */
import type { WorkbenchQuestionnaireHistoryEntry, WorkbenchSteerHistoryEntry } from "../../types.ts";
import type { UserInput } from "../thread/workbench-thread-items.ts";
import type { WorkbenchTranscriptSnapshot } from "../database/transcript/workbench-transcript-contract.ts";
import type { WorkbenchProjectedTranscriptItem } from "../database/transcript/workbench-transcript-item-projection.ts";
import { workbenchThreadActions } from "../thread/thread-actions.ts";

type SnapshotRows = WorkbenchTranscriptSnapshot["rows"];

export interface TranscriptSideEntries {
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  steerEntries: WorkbenchSteerHistoryEntry[];
}

export function isTranscriptSideEntryItem(item: WorkbenchProjectedTranscriptItem) {
  return "requestKey" in item || (item.type === "generic" && item.nativeType === "workbenchSteer");
}

function heldSteerInput(part: SnapshotRows["threadHeldSteerParts"][number]): UserInput {
  const required = <Value>(value: Value | null) => {
    if (value === null) throw new Error("Stored held steer part is incomplete.");
    return value;
  };
  const detail = part.image_detail ? { detail: part.image_detail } : {};
  switch (part.part_type) {
    case "text": return { type: "text", text: required(part.text), text_elements: [] };
    case "image": return { type: "image", url: required(part.url), ...detail };
    case "localImage": return { type: "localImage", path: required(part.path), ...detail };
    case "audio": return { type: "audio", url: required(part.url) };
    case "localAudio": return { type: "localAudio", path: required(part.path) };
    case "skill":
    case "mention": return { type: part.part_type, name: required(part.name), path: required(part.path) };
  }
}

/** Held steers sit outside the transcript; history offers every one the user has not dismissed. */
function heldSteerEntries(snapshot: Pick<WorkbenchTranscriptSnapshot, "rows" | "thread">): WorkbenchSteerHistoryEntry[] {
  const partsBySteer = new Map<number, SnapshotRows["threadHeldSteerParts"]>();
  for (const part of snapshot.rows.threadHeldSteerParts) {
    partsBySteer.set(part.steer_id, [...partsBySteer.get(part.steer_id) ?? [], part]);
  }
  return snapshot.rows.threadHeldSteers.flatMap(steer => steer.state === "dismissed" ? [] : [{
    threadId: snapshot.thread.id, turnId: steer.turn_id, itemId: steer.public_id, entryKey: steer.entry_key,
    input: (partsBySteer.get(steer.id) ?? []).sort((left, right) => left.part_index - right.part_index).map(heldSteerInput),
    status: steer.state, attemptedAt: steer.attempted_at, resolvedAt: steer.resolved_at, requestId: steer.request_id,
    canonicalItemId: null, clientUserMessageId: steer.client_id, dispatchSequence: steer.dispatch_sequence,
    error: steer.error_text,
  }]);
}

/**
 * `order` names a turn's full item order when the caller read a wider context than the projected turns
 * (questionnaire placement counts only visible predecessors).
 */
export function projectTranscriptSideEntries(
  snapshot: Pick<WorkbenchTranscriptSnapshot, "rows" | "thread">,
  turns: readonly { id: string; items: readonly WorkbenchProjectedTranscriptItem[] }[],
  order?: (turnId: string) => readonly string[] | undefined,
): TranscriptSideEntries {
  const questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[] = [];
  const steerEntries: WorkbenchSteerHistoryEntry[] = [];
  const roots = new Map(snapshot.rows.threadItems.map(root => [root.public_id, root]));
  const inputs = new Map(snapshot.rows.threadItemUserMessages.map(row => [row.item_id, row]));
  for (const turn of turns) {
    const excluded = new Set(turn.items.filter(isTranscriptSideEntryItem).map(item => item.id));
    const itemOrder = order?.(turn.id);
    const visible: string[] = [];
    for (const item of turn.items) {
      if ("requestKey" in item) {
        const predecessors = itemOrder?.slice(0, itemOrder.indexOf(item.id)).filter(id => !excluded.has(id)) ?? visible;
        questionnaireEntries.push({
          threadId: snapshot.thread.id, turnId: turn.id, itemId: item.id, requestKey: item.requestKey,
          request: item.request, response: item.response, resolvedAt: item.resolvedAt,
          insertAfterItemId: predecessors.at(-1) ?? null, insertAfterItemIndex: predecessors.length - 1,
        });
        continue;
      }
      if (item.type === "generic" && item.nativeType === "workbenchSteer") {
        const retained = workbenchThreadActions["thread/steers/read"].result.safeParse({ data: [item.safeValue] });
        if (!retained.success) throw new Error("Stored Workbench steer history is invalid.");
        const entry = retained.data.data[0]!;
        // Audio steers are retained as generic payloads; a dismissed one stays out of history like any other.
        if (entry.status !== "dismissed") steerEntries.push({ ...entry, itemId: item.id, threadId: snapshot.thread.id, turnId: turn.id });
        continue;
      }
      visible.push(item.id);
      const root = roots.get(item.id);
      const input = root ? inputs.get(root.id) : undefined;
      if (item.type === "userMessage" && root && input?.input_kind === "steer") {
        steerEntries.push({
          threadId: snapshot.thread.id, turnId: turn.id, itemId: item.id, entryKey: item.id,
          input: item.content, status: "sent",
          attemptedAt: root.created_at, resolvedAt: root.updated_at, requestId: null,
          canonicalItemId: item.id, clientUserMessageId: input.client_id, error: null,
        });
      }
    }
  }
  steerEntries.push(...heldSteerEntries(snapshot));
  return { questionnaireEntries, steerEntries };
}
