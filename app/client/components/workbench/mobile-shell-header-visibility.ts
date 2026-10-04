/*
 * Exports:
 * - MobileShellHeaderEvent: gesture input or top-of-view observation.
 * - MobileShellHeaderVisibility: gesture and scroll-movement visibility state.
 * - advanceMobileShellHeaderVisibility: apply touch lifecycle, gesture, or scroll observation.
 */

export interface MobileShellHeaderVisibility {
  visible: boolean;
  direction: "up" | "down" | null;
  travelPx: number;
  lastScroll: { scrollTop: number; scrollHeight: number; clientHeight: number } | null;
  gestureSinceLastScroll: boolean;
  touchPhase: "none" | "pending" | "reporting";
}

export type MobileShellHeaderEvent =
  | { kind: "gesture"; direction: "up" | "down"; travelPx: number }
  | { kind: "touch"; active: boolean }
  | { kind: "scroll"; scrollTop: number; scrollHeight: number; clientHeight: number };

const HIDE_TRAVEL_PX = 24;
const SHOW_TRAVEL_PX = 8;

function applyTravel(
  state: MobileShellHeaderVisibility,
  direction: "up" | "down",
  distance: number,
) {
  if (distance < 1) return state;
  const travelPx = direction === state.direction ? state.travelPx + distance : distance;
  const shouldHide = direction === "down" && state.visible && travelPx >= HIDE_TRAVEL_PX;
  const shouldShow = direction === "up" && !state.visible && travelPx >= SHOW_TRAVEL_PX;
  return {
    ...state,
    visible: shouldHide ? false : shouldShow ? true : state.visible,
    direction,
    travelPx: shouldHide || shouldShow ? 0 : travelPx,
  };
}

export function advanceMobileShellHeaderVisibility(
  state: MobileShellHeaderVisibility,
  event: MobileShellHeaderEvent,
): MobileShellHeaderVisibility {
  if (event.kind === "touch") {
    return { ...state, touchPhase: event.active ? "pending" : "none" };
  }
  if (event.kind === "gesture") {
    return {
      ...applyTravel(state, event.direction, event.travelPx),
      gestureSinceLastScroll: true,
      touchPhase: state.touchPhase === "none" ? "none" : "reporting",
    };
  }

  const previous = state.lastScroll;
  const next = {
    ...state,
    lastScroll: {
      scrollTop: event.scrollTop,
      scrollHeight: event.scrollHeight,
      clientHeight: event.clientHeight,
    },
    gestureSinceLastScroll: false,
  };
  if (event.scrollTop <= 0) {
    return { ...next, visible: true, direction: null, travelPx: 0 };
  }
  if (!previous || state.gestureSinceLastScroll || state.touchPhase === "reporting"
    || previous.scrollHeight !== event.scrollHeight
    || previous.clientHeight !== event.clientHeight) return next;

  const delta = event.scrollTop - previous.scrollTop;
  if (Math.abs(delta) < 1) return next;
  return applyTravel(next, delta > 0 ? "down" : "up", Math.abs(delta));
}
