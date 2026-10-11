/*
 * Exports:
 * - mouseActionBuilders: validate and build coordinate mouse and touch Browse actions.
 */
import {
  buildBrowserAction,
  normalizeFiniteActionNumber,
  normalizePositiveActionInteger,
  type BrowseActionBuilder,
} from "./session-actions";

const BUTTONS = new Set(["left", "middle", "right"]);

export const mouseActionBuilders: readonly BrowseActionBuilder[] = [
  (action) => {
    if (action.action !== "mouseClick") return null;
    const x = normalizeFiniteActionNumber(action.x, "Browse mouseClick requires a finite x coordinate.");
    const y = normalizeFiniteActionNumber(action.y, "Browse mouseClick requires a finite y coordinate.");
    if (!x.ok) return { error: x.error };
    if (!y.ok) return { error: y.error };
    const button = action.button && BUTTONS.has(action.button) ? action.button : "left";
    const clickCount = normalizePositiveActionInteger(action.clickCount) ?? 1;
    return buildBrowserAction("mouseClick", action, "mouse.click", {
      button,
      clickCount,
      returnXPath: action.returnXPath === true,
      x: x.value,
      y: y.value,
    }, ["mouse", "click", String(x.value), String(y.value), "--button", button, "--click-count", String(clickCount), ...(action.returnXPath ? ["--return-xpath"] : [])]);
  },
  (action) => {
    if (action.action !== "mouseHover") return null;
    const x = normalizeFiniteActionNumber(action.x, "Browse mouseHover requires a finite x coordinate.");
    const y = normalizeFiniteActionNumber(action.y, "Browse mouseHover requires a finite y coordinate.");
    if (!x.ok) return { error: x.error };
    if (!y.ok) return { error: y.error };
    return buildBrowserAction("mouseHover", action, "mouse.hover", {
      returnXPath: action.returnXPath === true,
      x: x.value,
      y: y.value,
    }, ["mouse", "hover", String(x.value), String(y.value), ...(action.returnXPath ? ["--return-xpath"] : [])]);
  },
  (action) => {
    if (action.action !== "mouseDrag") return null;
    const values = [
      normalizeFiniteActionNumber(action.fromX, "Browse mouseDrag requires a finite fromX coordinate."),
      normalizeFiniteActionNumber(action.fromY, "Browse mouseDrag requires a finite fromY coordinate."),
      normalizeFiniteActionNumber(action.toX, "Browse mouseDrag requires a finite toX coordinate."),
      normalizeFiniteActionNumber(action.toY, "Browse mouseDrag requires a finite toY coordinate."),
    ];
    const failure = values.find((value) => !value.ok);
    if (failure && !failure.ok) return { error: failure.error };
    const [fromX, fromY, toX, toY] = values.map((value) => value.ok ? value.value : 0);
    const button = action.button && BUTTONS.has(action.button) ? action.button : "left";
    const delay = normalizePositiveActionInteger(action.delayMs) ?? 0;
    const steps = normalizePositiveActionInteger(action.steps) ?? 10;
    return buildBrowserAction("mouseDrag", action, "mouse.drag", {
      button,
      delay,
      fromX,
      fromY,
      returnXPath: action.returnXPath === true,
      steps,
      toX,
      toY,
    }, ["mouse", "drag", String(fromX), String(fromY), String(toX), String(toY), "--button", button, "--delay", String(delay), "--steps", String(steps), ...(action.returnXPath ? ["--return-xpath"] : [])]);
  },
  (action) => {
    if (action.action !== "mouseScroll") return null;
    const values = [
      normalizeFiniteActionNumber(action.x, "Browse mouseScroll requires a finite x coordinate."),
      normalizeFiniteActionNumber(action.y, "Browse mouseScroll requires a finite y coordinate."),
      normalizeFiniteActionNumber(action.deltaX, "Browse mouseScroll requires a finite deltaX value."),
      normalizeFiniteActionNumber(action.deltaY, "Browse mouseScroll requires a finite deltaY value."),
    ];
    const failure = values.find((value) => !value.ok);
    if (failure && !failure.ok) return { error: failure.error };
    const [x, y, deltaX, deltaY] = values.map((value) => value.ok ? value.value : 0);
    const intervalMs = normalizePositiveActionInteger(action.intervalMs) ?? 0;
    const repeat = normalizePositiveActionInteger(action.repeat) ?? 1;
    return buildBrowserAction("mouseScroll", action, "mouse.scroll", {
      deltaX,
      deltaY,
      intervalMs,
      park: action.park === true,
      repeat,
      returnXPath: action.returnXPath === true,
      x,
      y,
    }, [
      "mouse", "scroll", String(x), String(y), String(deltaX), String(deltaY),
      "--repeat", String(repeat),
      "--interval", String(intervalMs),
      ...(action.park ? ["--park"] : []),
      ...(action.returnXPath ? ["--return-xpath"] : []),
    ]);
  },
  (action) => {
    if (action.action !== "touchScroll") return null;
    const values = [
      normalizeFiniteActionNumber(action.x, "Browse touchScroll requires a finite x coordinate."),
      normalizeFiniteActionNumber(action.y, "Browse touchScroll requires a finite y coordinate."),
      normalizeFiniteActionNumber(action.deltaX, "Browse touchScroll requires a finite deltaX value."),
      normalizeFiniteActionNumber(action.deltaY, "Browse touchScroll requires a finite deltaY value."),
    ];
    const failure = values.find((value) => !value.ok);
    if (failure && !failure.ok) return { error: failure.error };
    const [x, y, deltaX, deltaY] = values.map((value) => value.ok ? value.value : 0);
    const intervalMs = normalizePositiveActionInteger(action.intervalMs) ?? 0;
    const repeat = normalizePositiveActionInteger(action.repeat) ?? 1;
    const speed = normalizePositiveActionInteger(action.speed) ?? 800;
    return buildBrowserAction("touchScroll", action, "workbench.touchScroll", {
      deltaX,
      deltaY,
      fling: action.fling === true,
      intervalMs,
      repeat,
      speed,
      x,
      y,
    }, [
      "touch", "scroll", String(x), String(y), String(deltaX), String(deltaY),
      "--speed", String(speed),
      "--repeat", String(repeat),
      "--interval", String(intervalMs),
      ...(action.fling ? ["--fling"] : []),
    ]);
  },
];
