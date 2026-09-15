/*
 * Exports:
 * - Turn/TurnStatus/TurnItemsView: Workbench turn state and loaded item window.
 * - TurnError: user-facing failure with retained structured provider evidence.
 * - ThreadStatus/ThreadActiveFlag: compatible thread availability and wait state.
 */
import type { JsonValue, ThreadItem } from "./workbench-thread-items.ts";

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type TurnItemsView = "notLoaded" | "summary" | "full";
export type TurnError = {
  message: string;
  additionalDetails: string | null;
  // Retained wire field. Shared code treats this as evidence, not native error policy.
  codexErrorInfo: JsonValue;
  misalignment: {
    errorType: string | null;
    detailedExplanation: string | null;
    steer: { message: string } | null;
  } | null;
}
export type Turn = {
  id: string;
  items: ThreadItem[];
  itemsView: TurnItemsView;
  status: TurnStatus;
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}
export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";
export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: ThreadActiveFlag[] };
