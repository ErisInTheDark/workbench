/*
 * Exports:
 * - ThreadMarkdownSectionActionsProvider: supply actions for the prose ending before each top-level markdown section break.
 * - default ThreadMarkdownSectionActions: slot rendered inside a section break; empty without a provider, so cached markdown stays reusable.
 */
"use client";

import { createContext, useContext, type ReactNode } from "react";

const ThreadMarkdownSectionActionsContext = createContext<((breakIndex: number) => ReactNode) | null>(null);

export const ThreadMarkdownSectionActionsProvider = ThreadMarkdownSectionActionsContext.Provider;

export default function ThreadMarkdownSectionActions({ breakIndex }: { breakIndex: number }) {
  return useContext(ThreadMarkdownSectionActionsContext)?.(breakIndex) ?? null;
}
