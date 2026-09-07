/*
 * Keywords: item, identity, provisional, reconciliation.
 * Exports:
 * - WorkbenchThreadItemIdentityKind: explicit identity evidence, never inferred from a public ID.
 * - WorkbenchIdentifiedThreadItem: admitted optional identity metadata on a provider-compatible item.
 * - getWorkbenchThreadItemIdentityKind: read admitted identity evidence.
 * - withWorkbenchThreadItemIdentity: attach identity evidence at the source boundary.
 */
import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem.ts";

export type WorkbenchThreadItemIdentityKind = "stable" | "provisional";

export type WorkbenchIdentifiedThreadItem = ThreadItem & { workbenchIdentityKind?: WorkbenchThreadItemIdentityKind };

export function getWorkbenchThreadItemIdentityKind(item: ThreadItem): WorkbenchThreadItemIdentityKind {
  return (item as WorkbenchIdentifiedThreadItem).workbenchIdentityKind ?? "stable";
}

export function withWorkbenchThreadItemIdentity<Item extends ThreadItem>(item: Item, kind: WorkbenchThreadItemIdentityKind): Item {
  return getWorkbenchThreadItemIdentityKind(item) === kind ? item : { ...item, workbenchIdentityKind: kind };
}
