/*
 * Exports:
 * - WorkbenchThreadDisplayOrderSchema/WorkbenchThreadDisplayOrder: project-level partial ordering persisted separately from thread records. Keywords: thread, display, ordering, schema.
 * - getWorkbenchThreadDisplayKey/getWorkbenchThreadDisplaySection: stable row identity and reorderable-section ownership. Keywords: thread, draft, pinned, snoozed, settled.
 * - normalizeWorkbenchThreadDisplayOrder/projectWorkbenchThreadDisplayOrder: resilient decoding and stable topological projection over natural order. Keywords: fallback, relation, topology.
 * - reconcileWorkbenchThreadDisplayOrder/moveWorkbenchThreadDisplayOrder: prune, snapshot, and mutate durable user-positioned relations. Keywords: arrival, transition, drag, snapshot.
 */

import { z } from "zod";

import type { WorkbenchThreadSidebarEntry } from "./thread-state";

export const WORKBENCH_THREAD_DISPLAY_SECTIONS = ["pinned", "snoozed", "settledPinned"] as const;
export type WorkbenchThreadDisplaySection = typeof WORKBENCH_THREAD_DISPLAY_SECTIONS[number];

const WorkbenchThreadDisplayPositionSchema = z.object({
  above: z.array(z.string().min(1)),
  below: z.array(z.string().min(1)),
}).strict();

export const WorkbenchThreadDisplayOrderSchema = z.object({
  pinned: z.record(z.string().min(1), WorkbenchThreadDisplayPositionSchema).optional(),
  settledPinned: z.record(z.string().min(1), WorkbenchThreadDisplayPositionSchema).optional(),
  snoozed: z.record(z.string().min(1), WorkbenchThreadDisplayPositionSchema).optional(),
}).strict();
export type WorkbenchThreadDisplayOrder = z.infer<typeof WorkbenchThreadDisplayOrderSchema>;

export function getWorkbenchThreadDisplayKey(entry: WorkbenchThreadSidebarEntry) {
  return entry.entryKind === "draft"
    ? `draft:${entry.draft.draftId}`
    : `${entry.identity.harness}:${entry.identity.threadId}`;
}

export function getWorkbenchThreadDisplaySection(entry: WorkbenchThreadSidebarEntry): WorkbenchThreadDisplaySection | null {
  if (entry.entryKind === "subagent") return null;
  if (entry.metadata.archived) return null;
  if (entry.metadata.snoozed) return "snoozed";
  if (entry.entryKind !== "draft" && entry.lifecycle.settled) return entry.metadata.pinned ? "settledPinned" : null;
  return entry.metadata.pinned ? "pinned" : null;
}

export function normalizeWorkbenchThreadDisplayOrder(candidate: unknown): WorkbenchThreadDisplayOrder {
  const parsed = WorkbenchThreadDisplayOrderSchema.safeParse(candidate);
  return parsed.success ? parsed.data : {};
}

function sectionEntries(entries: readonly WorkbenchThreadSidebarEntry[], section: WorkbenchThreadDisplaySection) {
  return entries.filter((entry) => getWorkbenchThreadDisplaySection(entry) === section);
}

function projectSection(
  entries: readonly WorkbenchThreadSidebarEntry[],
  positions: Record<string, { above: string[]; below: string[] }> | undefined,
) {
  if (!positions || !Object.keys(positions).length || entries.length < 2) return [...entries];
  const keys = entries.map(getWorkbenchThreadDisplayKey);
  const keySet = new Set(keys);
  const naturalIndex = new Map(keys.map((key, index) => [key, index]));
  const outgoing = new Map(keys.map((key) => [key, new Set<string>()]));
  const indegree = new Map(keys.map((key) => [key, 0]));
  const addEdge = (before: string, after: string) => {
    if (before === after || !keySet.has(before) || !keySet.has(after)) return;
    const targets = outgoing.get(before)!;
    if (targets.has(after)) return;
    targets.add(after);
    indegree.set(after, (indegree.get(after) ?? 0) + 1);
  };
  for (const [key, position] of Object.entries(positions)) {
    if (!keySet.has(key)) continue;
    for (const above of position.above) addEdge(above, key);
    for (const below of position.below) addEdge(key, below);
  }
  const ready = keys.filter((key) => indegree.get(key) === 0);
  const result: string[] = [];
  while (ready.length) {
    ready.sort((left, right) => naturalIndex.get(left)! - naturalIndex.get(right)!);
    const key = ready.shift()!;
    result.push(key);
    for (const target of outgoing.get(key) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (result.length !== keys.length) return [...entries];
  const byKey = new Map(entries.map((entry) => [getWorkbenchThreadDisplayKey(entry), entry]));
  return result.map((key) => byKey.get(key)!);
}

export function projectWorkbenchThreadDisplayOrder(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
) {
  const order = normalizeWorkbenchThreadDisplayOrder(candidate);
  const projectedBySection = new Map(WORKBENCH_THREAD_DISPLAY_SECTIONS.map((section) => [
    section,
    projectSection(sectionEntries(naturallyOrderedEntries, section), order[section]),
  ]));
  const indexes = new Map(WORKBENCH_THREAD_DISPLAY_SECTIONS.map((section) => [section, 0]));
  return naturallyOrderedEntries.map((entry) => {
    const section = getWorkbenchThreadDisplaySection(entry);
    if (!section) return entry;
    const index = indexes.get(section) ?? 0;
    indexes.set(section, index + 1);
    return projectedBySection.get(section)?.[index] ?? entry;
  });
}

function snapshotSection(
  projected: readonly WorkbenchThreadSidebarEntry[],
  positionedKeys: ReadonlySet<string>,
) {
  const keys = projected.map(getWorkbenchThreadDisplayKey);
  return Object.fromEntries(keys.flatMap((key, index) => positionedKeys.has(key)
    ? [[key, { above: keys.slice(0, index), below: keys.slice(index + 1) }]]
    : []));
}

export function reconcileWorkbenchThreadDisplayOrder(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
): WorkbenchThreadDisplayOrder {
  const order = normalizeWorkbenchThreadDisplayOrder(candidate);
  const next: WorkbenchThreadDisplayOrder = {};
  for (const section of WORKBENCH_THREAD_DISPLAY_SECTIONS) {
    const entries = sectionEntries(naturallyOrderedEntries, section);
    const keys = new Set(entries.map(getWorkbenchThreadDisplayKey));
    const positioned = new Set(Object.keys(order[section] ?? {}).filter((key) => keys.has(key)));
    if (!positioned.size) continue;
    const projected = projectSection(entries, order[section]);
    const snapshot = snapshotSection(projected, positioned);
    if (Object.keys(snapshot).length) next[section] = snapshot;
  }
  return next;
}

export function moveWorkbenchThreadDisplayOrder(
  naturallyOrderedEntries: readonly WorkbenchThreadSidebarEntry[],
  candidate: unknown,
  section: WorkbenchThreadDisplaySection,
  sourceKey: string,
  beforeKey: string | null,
): WorkbenchThreadDisplayOrder | null {
  const order = reconcileWorkbenchThreadDisplayOrder(naturallyOrderedEntries, candidate);
  const entries = projectSection(sectionEntries(naturallyOrderedEntries, section), order[section]);
  const sourceIndex = entries.findIndex((entry) => getWorkbenchThreadDisplayKey(entry) === sourceKey);
  if (sourceIndex < 0 || (beforeKey !== null && !entries.some((entry) => getWorkbenchThreadDisplayKey(entry) === beforeKey))) return null;
  if (beforeKey === sourceKey) return order;
  const [source] = entries.splice(sourceIndex, 1);
  const insertionIndex = beforeKey === null
    ? entries.length
    : entries.findIndex((entry) => getWorkbenchThreadDisplayKey(entry) === beforeKey);
  entries.splice(insertionIndex, 0, source!);
  const positioned = new Set([...Object.keys(order[section] ?? {}), sourceKey]);
  const nextSection = snapshotSection(entries, positioned);
  return { ...order, [section]: nextSection };
}

export function isWorkbenchThreadDisplayOrderEmpty(candidate: unknown) {
  const order = normalizeWorkbenchThreadDisplayOrder(candidate);
  return WORKBENCH_THREAD_DISPLAY_SECTIONS.every((section) => !Object.keys(order[section] ?? {}).length);
}
