/*
 * Exports:
 * - ControlStateStore: an outside owner of control values by control id, such as a vis page's synced `wb.state`.
 * - ControlStateContext: the store controls below it read and write; the app provides none.
 * - useControlState: a control's value and setter: the store's when one is provided and the control has an id, otherwise
 *   ordinary local state.
 */
import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";

export interface ControlStateStore {
  get(id: string): unknown;
  set(id: string, value: unknown): void;
  subscribe(listener: () => void): () => void;
}

export const ControlStateContext = createContext<ControlStateStore | null>(null);

const NO_SUBSCRIPTION = () => () => {};

/**
 * `synced` tells a control its value belongs to the store, so it must never write defaults there on its own: only the
 * user's changes are stored. Setting an unchanged value is a no-op, so echoes of the current value never reach it.
 */
export function useControlState<Value>(id: string | undefined, initial: Value): [Value, (value: Value) => void, boolean] {
  const provided = useContext(ControlStateContext);
  const store = provided && id ? provided : null;
  const [local, setLocal] = useState(initial);
  const read = () => store?.get(id!);
  const stored = useSyncExternalStore(store ? store.subscribe : NO_SUBSCRIPTION, read, read);
  // A control's stored value only ever comes from that same control's setter, so it has the control's type.
  const value = store ? (stored === undefined ? initial : stored as Value) : local;
  const set = useCallback((next: Value) => {
    if (!store) return setLocal(next);
    if (JSON.stringify(next) !== JSON.stringify(store.get(id!))) store.set(id!, next);
  }, [id, store]);
  return [value, set, Boolean(store)];
}
