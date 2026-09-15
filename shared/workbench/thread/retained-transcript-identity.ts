/*
 * Exports:
 * - readRetainedTranscriptIdentityKind: decode legacy rows lacking admitted source evidence.
 */
import type { WorkbenchThreadItemIdentityKind } from "./thread-item-identity.ts";

export function readRetainedTranscriptIdentityKind(item: {
  id: string;
  workbenchIdentityKind?: WorkbenchThreadItemIdentityKind;
}, provider = "codex"): WorkbenchThreadItemIdentityKind {
  return item.workbenchIdentityKind ?? (provider === "codex" && /^item-\d+$/u.test(item.id) ? "provisional" : "stable");
}
