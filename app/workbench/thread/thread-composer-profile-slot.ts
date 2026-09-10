/*
 * Exports:
 * - default resolveThreadComposerProfileSlot: map route identity and the active thread to its daemon profile target.
 */
import type { WorkbenchComposerProfileSlot, WorkbenchHarness } from "workbench-shared/types";
import type { DraftId, ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadRouteTarget } from "workbench-shared/workbench/thread/thread-state";

export default function resolveThreadComposerProfileSlot(
  projectId: ProjectId,
  target: WorkbenchThreadRouteTarget | null,
  thread: { harness: WorkbenchHarness } & (
    | { id: DraftId; isDraft: true }
    | { id: WorkbenchThreadId; isDraft: false }
  ),
): WorkbenchComposerProfileSlot {
  if (target?.kind === "new") return { kind: "new-thread", projectId };
  if (target?.kind === "draft") {
    return { draftId: target.draftId, harness: thread.harness, kind: "draft", projectId };
  }
  if (!target && thread.isDraft) {
    return { draftId: thread.id, harness: thread.harness, kind: "draft", projectId };
  }
  if (thread.isDraft) throw new Error("A provider profile target requires a materialized thread.");
  return { harness: thread.harness, kind: "thread", projectId, threadId: thread.id };
}
