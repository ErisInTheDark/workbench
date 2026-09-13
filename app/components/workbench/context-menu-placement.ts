/*
 * Exports:
 * - ContextMenuPlacementScope: layout projection that an open context menu may hold.
 * - ContextMenuPlacementSnapshot: one generation's captured placement value.
 * - resolveContextMenuPlacementSnapshot: retain or release a placement snapshot across menu generations.
 * - mergeContextMenuPlacementEntries: preserve frozen membership and order while substituting current entries.
 * - useContextMenuPlacementSnapshot: bind a component's placement projection to the active scoped menu.
 * - default WorkbenchContextMenuPlacementContext: active placement lock published by the menu provider.
 */
"use client";

import { createContext, useContext, useRef } from "react";

export type ContextMenuPlacementScope = "thread-list";

interface ContextMenuPlacementLock {
  generation: number;
  scope: ContextMenuPlacementScope;
}

export interface ContextMenuPlacementSnapshot<Value> {
  generation: number;
  value: Value;
}

export function resolveContextMenuPlacementSnapshot<Value>(
  generation: number | null,
  value: Value,
  snapshot: ContextMenuPlacementSnapshot<Value> | null,
) {
  if (generation === null) return { snapshot: null, value };
  if (snapshot?.generation === generation) return { snapshot, value: snapshot.value };
  const next = { generation, value };
  return { snapshot: next, value };
}

export function mergeContextMenuPlacementEntries<Entry, Key>(
  placementEntries: readonly Entry[],
  currentEntries: readonly Entry[],
  getKey: (entry: Entry) => Key,
) {
  const currentByKey = new Map(currentEntries.map(entry => [getKey(entry), entry]));
  return placementEntries.map(entry => currentByKey.get(getKey(entry)) ?? entry);
}

const WorkbenchContextMenuPlacementContext = createContext<ContextMenuPlacementLock | null>(null);

export function useContextMenuPlacementSnapshot<Value>(
  scope: ContextMenuPlacementScope,
  value: Value,
) {
  const lock = useContext(WorkbenchContextMenuPlacementContext);
  const snapshotRef = useRef<ContextMenuPlacementSnapshot<Value> | null>(null);
  const resolved = resolveContextMenuPlacementSnapshot(
    lock?.scope === scope ? lock.generation : null,
    value,
    snapshotRef.current,
  );
  snapshotRef.current = resolved.snapshot;
  return resolved.value;
}

export default WorkbenchContextMenuPlacementContext;
