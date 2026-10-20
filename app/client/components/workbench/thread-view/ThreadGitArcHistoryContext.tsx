/*
 * Exports:
 * - default ThreadGitArcHistoryContext: how a retried Git arc start got there (its failed attempts and the steps between),
 *   for the successful start's card to open onto; null everywhere else, including inside that history.
 * - ThreadGitArcHistory: that history's rendered steps and failed attempt count.
 */
"use client";

import { createContext, type ReactNode } from "react";

export interface ThreadGitArcHistory {
  content: ReactNode;
  failedAttempts: number;
}

const ThreadGitArcHistoryContext = createContext<ThreadGitArcHistory | null>(null);

export default ThreadGitArcHistoryContext;
