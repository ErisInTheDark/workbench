/*
 * Exports:
 * - ThreadSteerActions: resend or dismiss one undelivered steer of the viewed thread.
 * - default ThreadSteerActionsContext: provide those actions to transcript items; null where steers are read-only.
 */
"use client";

import { createContext } from "react";

export interface ThreadSteerActions {
  resend(itemId: string): Promise<void>;
  dismiss(itemId: string): Promise<void>;
}

const ThreadSteerActionsContext = createContext<ThreadSteerActions | null>(null);

export default ThreadSteerActionsContext;
