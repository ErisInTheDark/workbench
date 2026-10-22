/*
 * Exports:
 * - default ThreadGitArcHistoryContext: how a Git arc card got there (a retried start's failed attempts and the steps between,
 *   or a proposal's lead-in arc steps), for that card to open onto; null everywhere else, including inside that history.
 * - ThreadGitArcHistory: that history's rendered steps and failed attempt count (0 for a lead-in).
 */
"use client";

import { createContext, type ReactNode } from "react";

export interface ThreadGitArcHistory {
  content: ReactNode;
  failedAttempts: number;
}

const ThreadGitArcHistoryContext = createContext<ThreadGitArcHistory | null>(null);

export default ThreadGitArcHistoryContext;
