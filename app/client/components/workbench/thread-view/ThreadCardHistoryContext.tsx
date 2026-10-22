/*
 * Exports:
 * - default ThreadCardHistoryContext: how a card got there (a retried arc start's failed attempts and the steps between,
 *   a proposal's lead-in arc steps, or the todo listing before an add or removal), for that card to open onto; null
 *   everywhere else, including inside that history.
 * - ThreadCardHistory: that history's rendered steps and failed attempt count (0 for a lead-in).
 */
"use client";

import { createContext, type ReactNode } from "react";

export interface ThreadCardHistory {
  content: ReactNode;
  failedAttempts: number;
}

const ThreadCardHistoryContext = createContext<ThreadCardHistory | null>(null);

export default ThreadCardHistoryContext;
