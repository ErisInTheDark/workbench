/*
 * Exports:
 * - WorkbenchThreadItemIdentityKind: explicit identity evidence, never inferred from a public ID.
 * - WorkbenchIdentifiedThreadItem: admitted optional identity metadata on a provider-compatible item.
 * - getWorkbenchThreadItemIdentityKind: read admitted identity evidence.
 * - withWorkbenchThreadItemIdentity: attach identity evidence at the source boundary.
 */
import type { ThreadItem } from "./workbench-thread-items.ts";

export type WorkbenchThreadItemIdentityKind = "stable" | "provisional";

export type WorkbenchIdentifiedThreadItem = ThreadItem & { workbenchIdentityKind?: WorkbenchThreadItemIdentityKind };

export function getWorkbenchThreadItemIdentityKind(item: { id: string; workbenchIdentityKind?: WorkbenchThreadItemIdentityKind }): WorkbenchThreadItemIdentityKind {
  return item.workbenchIdentityKind ?? "stable";
}

export function withWorkbenchThreadItemIdentity<Item extends ThreadItem>(item: Item, kind: WorkbenchThreadItemIdentityKind): Item {
  return getWorkbenchThreadItemIdentityKind(item) === kind ? item : { ...item, workbenchIdentityKind: kind };
}
