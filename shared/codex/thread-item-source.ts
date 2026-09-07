/*
 * Keywords: Codex, native identity, snapshot, provisional, adapter.
 * Exports:
 * - getCodexItemIdentityKind: interpret Codex's provisional snapshot IDs at the native boundary.
 * - withCodexItemMetadata: convert native and retained input evidence before core use.
 */
import type { ThreadItem } from "./generated/app-server/v2/ThreadItem.ts";
import { getWorkbenchInputState, withWorkbenchInputState } from "../workbench/thread/thread-input-item.ts";
import { withWorkbenchThreadItemIdentity } from "../workbench/thread/thread-item-identity.ts";
import type { WorkbenchThreadItemIdentityKind } from "../workbench/thread/thread-item-identity.ts";

export function getCodexItemIdentityKind(item: { id: string; workbenchIdentityKind?: WorkbenchThreadItemIdentityKind }): WorkbenchThreadItemIdentityKind {
  return item.workbenchIdentityKind
    ?? (/^item-\d+$/u.test(item.id) ? "provisional" : "stable");
}

export function withCodexItemMetadata(item: ThreadItem): ThreadItem {
  const admitted = withWorkbenchThreadItemIdentity(item, getCodexItemIdentityKind(item));
  if (admitted.type !== "userMessage" || getWorkbenchInputState(admitted)) return admitted;
  const status = /^workbench:steer-history:(pending|sent|failed|interrupted):/u.exec(admitted.id)?.[1];
  if (status !== "pending" && status !== "sent" && status !== "failed" && status !== "interrupted") return admitted;
  return withWorkbenchInputState(admitted, { kind: "steer", status });
}
