/*
 * Exports:
 * - ThreadItemActions: user actions on transcript items of the viewed thread: resend or dismiss an undelivered steer, stop a running wb shell or stoppable call (such as mcp_call), or start a queued shell now.
 * - default ThreadItemActionsContext: provide those actions to transcript items; null where items are read-only.
 */
"use client";

import { createContext } from "react";

export interface ThreadItemActions {
  resendSteer(itemId: string): Promise<void>;
  dismissSteer(itemId: string): Promise<void>;
  stopCall(itemId: string): Promise<void>;
  startShellNow(itemId: string): Promise<void>;
}

const ThreadItemActionsContext = createContext<ThreadItemActions | null>(null);

export default ThreadItemActionsContext;
