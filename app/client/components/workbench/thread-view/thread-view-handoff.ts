/*
 * Exports:
 * - ThreadViewDisplay: the root currently displayed by one stable thread surface.
 * - resolveThreadViewHandoff: select the visible root while a launched thread becomes renderable.
 */
import type { WorkbenchThreadRouteTarget } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadTurnsSlice } from "../../../workbench/thread/ThreadStore";

export interface ThreadViewDisplay {
  projectId: string;
  viewInstanceKey: string;
  target: Exclude<WorkbenchThreadRouteTarget, { kind: "new" | "subagent" }>;
}

export function resolveThreadViewHandoff(
  previous: ThreadViewDisplay | null,
  requested: ThreadViewDisplay,
  { hasDraftInput, headReady, turns }: { hasDraftInput: boolean; headReady: boolean; turns: ThreadTurnsSlice },
): ThreadViewDisplay {
  const sameView = previous?.projectId === requested.projectId
    && previous.viewInstanceKey === requested.viewInstanceKey;
  if (sameView && previous.target.kind === "draft" && requested.target.kind === "provider" && hasDraftInput) {
    const source = turns.transcript;
    const projection = "projection" in source ? source.projection : null;
    const ready = headReady && projection?.thread.id === requested.target.threadId
      && projection.display.segments.some(segment => segment.items.some(item => item.type === "userMessage"));
    if (!ready) return previous;
  }
  if (sameView && (
    previous.target.kind === "draft" && requested.target.kind === "draft"
      && previous.target.draftId === requested.target.draftId
    || previous.target.kind === "provider" && requested.target.kind === "provider"
      && previous.target.threadId === requested.target.threadId && previous.target.harness === requested.target.harness
  )) return previous;
  return requested;
}
