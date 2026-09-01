/*
 * Exports:
 * - default resolveThreadComposerProfileSlot: map authoritative route identity and the active thread to its daemon profile target. Keywords: thread, route, composer, profile, target.
 */
import type { ThreadPayload, WorkbenchComposerProfileSlot } from "../../types";
import type { WorkbenchThreadTarget } from "./thread-state";

export default function resolveThreadComposerProfileSlot(
  projectId: string,
  target: WorkbenchThreadTarget | null,
  thread: Pick<ThreadPayload, "harness" | "id" | "isDraft">,
): WorkbenchComposerProfileSlot {
  if (target?.kind === "new") return { kind: "new-thread", projectId };
  if (target?.kind === "draft") {
    return { draftId: target.draftId, harness: thread.harness, kind: "draft", projectId };
  }
  if (!target && thread.isDraft) {
    return thread.id.startsWith("draft:")
      ? { draftId: thread.id.slice("draft:".length), harness: thread.harness, kind: "draft", projectId }
      : { kind: "new-thread", projectId };
  }
  return { harness: thread.harness, kind: "thread", projectId, threadId: thread.id };
}
