/*
 * Keywords: Codex, native identity, snapshot, provisional, adapter.
 * Exports:
 * - getCodexItemIdentityKind: interpret Codex's provisional snapshot IDs at the native boundary.
 * - withCodexItemMetadata: decorate native or retained identity/input metadata without interpreting content.
 */
import type { ThreadItem as NativeThreadItem } from "./generated/app-server/v2/ThreadItem.ts";
import type { ThreadItem } from "../workbench/thread/workbench-thread-items.ts";
import { getWorkbenchInputState, withWorkbenchInputState } from "../workbench/thread/thread-input-item.ts";
import { withWorkbenchThreadItemIdentity } from "../workbench/thread/thread-item-identity.ts";
import type { WorkbenchThreadItemIdentityKind } from "../workbench/thread/thread-item-identity.ts";

export function getCodexItemIdentityKind(item: { id: string; workbenchIdentityKind?: WorkbenchThreadItemIdentityKind }): WorkbenchThreadItemIdentityKind {
  return item.workbenchIdentityKind
    ?? (/^item-\d+$/u.test(item.id) ? "provisional" : "stable");
}

export function withCodexItemMetadata<Item extends ThreadItem | NativeThreadItem>(item: Item): Item {
  const admitted = withWorkbenchThreadItemIdentity(item, getCodexItemIdentityKind(item));
  if (admitted.type !== "userMessage" || getWorkbenchInputState(admitted)) return admitted;
  const status = /^workbench:steer-history:(pending|sent|failed|interrupted):/u.exec(admitted.id)?.[1];
  if (status !== "pending" && status !== "sent" && status !== "failed" && status !== "interrupted") return admitted;
  return withWorkbenchInputState({ ...admitted, type: "userMessage" as const }, { kind: "steer", status });
}
