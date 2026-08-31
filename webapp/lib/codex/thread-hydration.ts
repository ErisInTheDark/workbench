/*
 * Exports:
 * - WorkbenchThreadHydrationRequest: Codex transcript window request kept outside browser contracts. Keywords: codex, transcript, hydration, internal.
 */

export type WorkbenchThreadHydrationRequest =
  | { mode: "latest" }
  | { beforeTurnId: string; mode: "previous" }
  | { mode: "legacyFull" };
