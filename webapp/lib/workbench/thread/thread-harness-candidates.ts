/*
 * Exports:
 * - getWorkbenchThreadHarnessCandidates: order provider-owned thread harness candidates while honoring exact local knowledge. Keywords: thread, harness, routing, candidates, opencode, codex.
 */
import type { WorkbenchHarness } from "../../types";

const THREAD_HARNESSES = ["codex", "copilot", "opencode"] as const satisfies readonly WorkbenchHarness[];

export function getWorkbenchThreadHarnessCandidates(threadId: string, knownHarness?: WorkbenchHarness | null) {
  if (knownHarness) return [knownHarness];
  const preferredHarness: WorkbenchHarness = threadId.startsWith("ses_") ? "opencode" : "codex";
  return [
    preferredHarness,
    ...THREAD_HARNESSES.filter((candidateHarness) => candidateHarness !== preferredHarness),
  ];
}
