/*
 * Exports:
 * - WorkbenchFileChangeFailureKind/WorkbenchFileChangeFailureMarker: Workbench-owned file-change presentation metadata and synthetic item. Keywords: file change, failure, unclaimed.
 * - WorkbenchFileChangeItem/WorkbenchFileUpdateChange: Codex file-change shapes with optional Workbench presentation metadata. Keywords: codex, thread item, extension.
 * - WORKBENCH_UNCLAIMED_FILE_CHANGE_REASON_PREFIX/createWorkbenchFileChangeFailureSystemMessage: identify claim denials and encode bounded attempted-change metadata. Keywords: apply_patch, claim, hook.
 * - readWorkbenchFileChangeFailureMarker: derive one synthetic failed item from an ordered Codex hook notification. Keywords: validation, hook, marker.
 * - getWorkbenchFileChangeFailureKey/withWorkbenchFileChangeFailure: identify and decorate matching file-change items. Keywords: correlation, presentation.
 */
import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem.ts";

type CodexFileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;
type CodexFileUpdateChange = CodexFileChangeItem["changes"][number];

export const WORKBENCH_UNCLAIMED_FILE_CHANGE_REASON_PREFIX = "apply_patch denied. No active Git arc claim covers ";

const WORKBENCH_UNCLAIMED_FILE_CHANGE_REASON_SUFFIX = ". Claim every path before editing.";
const WORKBENCH_FILE_CHANGE_FAILURE_SYSTEM_MESSAGE_PREFIX = "workbench:file-change-failure:v1:";
const MAX_WORKBENCH_FILE_CHANGE_FAILURE_SYSTEM_MESSAGE_LENGTH = 64 * 1024;
const CODEX_APPLY_PATCH_ITEM_ID_PATTERN = /:(exec-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

export type WorkbenchFileChangeFailureKind = "unclaimed";

export interface WorkbenchFileChangeFailureMarker {
  insertAfterItemId: string | null;
  item: WorkbenchFileChangeItem;
  threadId: string;
  turnId: string;
}

export type WorkbenchFileUpdateChange = CodexFileUpdateChange & {
  workbenchAdditions?: number;
  workbenchDeletions?: number;
};

export type WorkbenchFileChangeItem = Omit<CodexFileChangeItem, "changes"> & {
  changes: WorkbenchFileUpdateChange[];
  workbenchFailureKind?: WorkbenchFileChangeFailureKind;
};

export interface WorkbenchFileChangeFailureSummary {
  additions: number;
  deletions: number;
  kind: CodexFileUpdateChange["kind"];
  path: string;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function identifier(value: unknown) {
  return typeof value === "string" && value.trim() && !value.includes("\0") ? value.trim() : null;
}

function count(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function readSummary(value: unknown): WorkbenchFileChangeFailureSummary | null {
  const summary = record(value);
  const kind = record(summary?.kind);
  const path = identifier(summary?.path);
  const additions = count(summary?.additions);
  const deletions = count(summary?.deletions);
  if (!path || additions === null || deletions === null) return null;
  if (kind?.type === "add") return { additions, deletions, kind: { type: "add" }, path };
  if (kind?.type === "delete") return { additions, deletions, kind: { type: "delete" }, path };
  if (kind?.type !== "update" || (kind.move_path !== null && !identifier(kind.move_path))) return null;
  return {
    additions,
    deletions,
    kind: { move_path: kind.move_path === null ? null : identifier(kind.move_path), type: "update" },
    path,
  };
}

export function createWorkbenchFileChangeFailureSystemMessage(changes: WorkbenchFileChangeFailureSummary[]) {
  if (!changes.length) return null;
  const message = `${WORKBENCH_FILE_CHANGE_FAILURE_SYSTEM_MESSAGE_PREFIX}${JSON.stringify({ changes })}`;
  return message.length <= MAX_WORKBENCH_FILE_CHANGE_FAILURE_SYSTEM_MESSAGE_LENGTH ? message : null;
}

export function readWorkbenchFileChangeFailureMarker(value: unknown): WorkbenchFileChangeFailureMarker | null {
  const notification = record(value);
  const run = record(notification?.run);
  const threadId = identifier(notification?.threadId);
  const turnId = identifier(notification?.turnId);
  const runId = identifier(run?.id);
  if (!threadId || !turnId || !runId || run?.eventName !== "preToolUse" || run.status !== "blocked" || !Array.isArray(run.entries)) {
    return null;
  }

  const isWorkbenchDenial = run.entries.some((value) => {
    const entry = record(value);
    return entry?.kind === "feedback"
      && typeof entry.text === "string"
      && entry.text.startsWith(WORKBENCH_UNCLAIMED_FILE_CHANGE_REASON_PREFIX)
      && entry.text.endsWith(WORKBENCH_UNCLAIMED_FILE_CHANGE_REASON_SUFFIX);
  });
  const warning = run.entries.find((value) => {
    const entry = record(value);
    return entry?.kind === "warning"
      && typeof entry.text === "string"
      && entry.text.startsWith(WORKBENCH_FILE_CHANGE_FAILURE_SYSTEM_MESSAGE_PREFIX);
  });
  const warningText = record(warning)?.text;
  const itemId = runId.match(CODEX_APPLY_PATCH_ITEM_ID_PATTERN)?.[1] ?? null;
  if (!isWorkbenchDenial || !itemId || typeof warningText !== "string" || warningText.length > MAX_WORKBENCH_FILE_CHANGE_FAILURE_SYSTEM_MESSAGE_LENGTH) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(warningText.slice(WORKBENCH_FILE_CHANGE_FAILURE_SYSTEM_MESSAGE_PREFIX.length)) as unknown;
  } catch {
    return null;
  }
  const changeValues = record(payload)?.changes;
  if (!Array.isArray(changeValues) || !changeValues.length || changeValues.length > 4_096) return null;
  const summaries = changeValues.map(readSummary);
  if (summaries.some((summary) => !summary)) return null;

  return {
    insertAfterItemId: null,
    item: {
      changes: (summaries as WorkbenchFileChangeFailureSummary[]).map((summary) => ({
        diff: "",
        kind: summary.kind,
        path: summary.path,
        workbenchAdditions: summary.additions,
        workbenchDeletions: summary.deletions,
      })),
      id: itemId,
      status: "failed",
      type: "fileChange",
      workbenchFailureKind: "unclaimed",
    },
    threadId,
    turnId,
  };
}

export function getWorkbenchFileChangeFailureKey({
  itemId,
  threadId,
  turnId,
}: {
  itemId: string;
  threadId: string;
  turnId: string;
}) {
  return `${threadId}\0${turnId}\0${itemId}`;
}

export function withWorkbenchFileChangeFailure(
  item: CodexFileChangeItem,
  kind: WorkbenchFileChangeFailureKind,
): WorkbenchFileChangeItem {
  const workbenchItem = item as WorkbenchFileChangeItem;
  return workbenchItem.workbenchFailureKind === kind ? workbenchItem : { ...item, workbenchFailureKind: kind };
}
