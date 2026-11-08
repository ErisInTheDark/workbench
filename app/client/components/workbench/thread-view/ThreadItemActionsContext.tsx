/*
 * Exports:
 * - ThreadItemActions: user actions on transcript items of the viewed thread: resend or dismiss an undelivered steer, stop a running wb shell or stoppable call (such as mcp_call), start a queued shell now, or take back a child this thread promoted.
 * - readOnlyThreadItemActions: actions for fixture transcripts (render lab, vis previews) that each report read-only.
 * - default ThreadItemActionsContext: provide those actions to transcript items; null where items are read-only.
 */
"use client";

import { createContext } from "react";

export interface ThreadItemActions {
  resendSteer(itemId: string): Promise<void>;
  dismissSteer(itemId: string): Promise<void>;
  stopCall(itemId: string): Promise<void>;
  startShellNow(itemId: string): Promise<void>;
  takeBackPromotedSubagent(itemId: string, childThreadId: string): Promise<void>;
}

const readOnly = async () => { throw new Error("This transcript is a read-only preview."); };
/** Fixture transcripts draw item controls as the app does; pressing one reports that the preview cannot change. */
export const readOnlyThreadItemActions: ThreadItemActions = {
  resendSteer: readOnly, dismissSteer: readOnly, stopCall: readOnly, startShellNow: readOnly, takeBackPromotedSubagent: readOnly,
};

const ThreadItemActionsContext = createContext<ThreadItemActions | null>(null);

export default ThreadItemActionsContext;
