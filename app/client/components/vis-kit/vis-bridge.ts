/*
 * Exports:
 * - VisBridge: the `window.wb` object Workbench injects into every vis frame.
 * - useVisState: state the user sets in a vis, synced by id: it survives the agent's edits and `wb vis read` returns it.
 */
import { useControlState, type ControlStateStore } from "../ui/control-state";

export interface VisBridge {
  /** The file's synced control state; `set` only reaches Workbench while the user has the vis focused. */
  state: ControlStateStore;
}

declare global {
  interface Window {
    wb?: VisBridge;
  }
}

/** Like `useState`, keyed by a control id; outside a vis it is ordinary local state. Rename the id only to reset it. */
export function useVisState<Value>(id: string, initial: Value) {
  const [value, set] = useControlState(id, initial);
  return [value, set] as const;
}
