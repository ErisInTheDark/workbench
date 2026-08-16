/*
 * Exports:
 * - PreviousTurnLoadStatus: loading or failed lifecycle states for one previous-turn boundary.
 * - PreviousTurnLoadState: track loading and failed previous-turn reads by thread boundary key.
 * - PreviousTurnLoadAction: lifecycle events accepted by the reducer.
 * - default previousTurnLoadReducer: own previous-turn read lifecycle transitions without mirror state.
 */

export type PreviousTurnLoadStatus = "loading" | "failed";

export type PreviousTurnLoadState = Record<string, PreviousTurnLoadStatus>;

export type PreviousTurnLoadAction =
  | { type: "start"; key: string }
  | { type: "succeed"; key: string }
  | { type: "fail"; key: string }
  | { type: "reset" };

export default function previousTurnLoadReducer(
  state: PreviousTurnLoadState,
  action: PreviousTurnLoadAction,
): PreviousTurnLoadState {
  if (action.type === "reset") {
    return Object.keys(state).length ? {} : state;
  }

  if (action.type === "start") {
    return state[action.key] === "loading"
      ? state
      : { ...state, [action.key]: "loading" };
  }

  if (action.type === "fail") {
    return state[action.key] === "failed"
      ? state
      : { ...state, [action.key]: "failed" };
  }

  if (!(action.key in state)) {
    return state;
  }

  const next = { ...state };
  delete next[action.key];
  return next;
}
