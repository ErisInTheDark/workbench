/*
 * Exports:
 * - stopWorkbenchThread: clear native Codex goal continuation before interrupting an active provider turn. Keywords: thread, stop, goal, interrupt, codex.
 */

import type { ThreadGoalClearParams } from "workbench-shared/codex/generated/app-server/v2/ThreadGoalClearParams";
import type { TurnInterruptParams } from "workbench-shared/codex/generated/app-server/v2/TurnInterruptParams";
import type { WorkbenchHarness } from "workbench-shared/types";

type WorkbenchThreadStopRequest =
  | { method: "thread/goal/clear"; params: ThreadGoalClearParams }
  | { method: "turn/interrupt"; params: TurnInterruptParams };

interface StopWorkbenchThreadOptions {
  harness: WorkbenchHarness;
  sendRequest: (harness: WorkbenchHarness, request: WorkbenchThreadStopRequest) => Promise<void>;
  threadId: string;
  turnId: string;
}

export async function stopWorkbenchThread({
  harness,
  sendRequest,
  threadId,
  turnId,
}: StopWorkbenchThreadOptions) {
  if (harness === "codex") {
    await sendRequest(harness, {
      method: "thread/goal/clear",
      params: { threadId },
    });
  }

  await sendRequest(harness, {
    method: "turn/interrupt",
    params: { threadId, turnId },
  });
}
