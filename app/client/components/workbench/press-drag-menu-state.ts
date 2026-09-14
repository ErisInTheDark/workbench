/*
 * Exports:
 * - PressDragMenuState/PressDragMenuEvent: one menu's display and pointer lifecycle.
 * - transitionPressDragMenu: compute highlighting, dismissal and a single confirmed action.
 */
export type PressDragMenuState =
  | { kind: "closed" }
  | { kind: "open"; activeId: string | null }
  | { kind: "dragging"; activeId: string | null; pointerId: number; x: number; y: number; moved: boolean };

export type PressDragMenuEvent =
  | { kind: "open"; activeId: string | null }
  | { kind: "press"; pointerId: number; x: number; y: number }
  | { kind: "move"; pointerId: number; x: number; y: number; id: string | null }
  | { kind: "release"; pointerId: number; x: number; y: number; id: string | null; onTrigger: boolean }
  | { kind: "highlight"; id: string | null }
  | { kind: "select"; id: string }
  | { kind: "key"; key: string; ids: readonly string[] }
  | { kind: "cancel" };

export function transitionPressDragMenu(state: PressDragMenuState, event: PressDragMenuEvent): { state: PressDragMenuState; selectedId: string | null; activate: boolean } {
  const result = (next: PressDragMenuState, selectedId: string | null = null, activate = false) => ({ state: next, selectedId, activate });
  if (event.kind === "cancel") return result({ kind: "closed" });
  if (event.kind === "open") return result({ kind: "open", activeId: event.activeId });
  if (event.kind === "press") return state.kind === "dragging" ? result(state) : result({
    kind: "dragging", activeId: null, pointerId: event.pointerId, x: event.x, y: event.y, moved: false,
  });
  if (state.kind === "closed") return result(state);
  if (event.kind === "move" || event.kind === "release") {
    if (state.kind !== "dragging" || state.pointerId !== event.pointerId) return result(state);
    const moved = state.moved || Math.hypot(event.x - state.x, event.y - state.y) > 4;
    if (event.kind === "move") return result({ ...state, activeId: event.id, moved });
    if (event.id) return result({ kind: "closed" }, event.id);
    return result({ kind: "closed" }, null, !moved && event.onTrigger);
  }
  if (event.kind === "highlight") return result({ ...state, activeId: event.id });
  if (event.kind === "select") return state.kind === "open" ? result({ kind: "closed" }, event.id) : result(state);
  if (event.kind === "key") {
    if (event.key === "Escape" || event.key === "Tab") return result({ kind: "closed" });
    if (state.kind !== "open") return result(state);
    if (event.key === "Enter" || event.key === " ") return result({ kind: "closed" }, state.activeId);
    const index = state.activeId === null ? -1 : event.ids.indexOf(state.activeId);
    const next = event.key === "Home" ? 0 : event.key === "End" ? event.ids.length - 1
      : event.key === "ArrowDown" ? Math.min(index + 1, event.ids.length - 1)
        : event.key === "ArrowUp" ? (index < 0 ? event.ids.length - 1 : Math.max(0, index - 1)) : index;
    return result({ kind: "open", activeId: event.ids[next] ?? null });
  }
  return result(state);
}
