/*
 * Exports:
 * - getWorkbenchThreadHarnessCandidates: preserve known identity or discover through installed providers.
 */
import type { WorkbenchHarness } from "../../types.ts";
import { installedProviderKeys } from "../provider/provider-registrations.ts";

export function getWorkbenchThreadHarnessCandidates(_threadId: string, knownHarness?: WorkbenchHarness | null) {
  if (knownHarness) return [knownHarness];
  return [...installedProviderKeys];
}
