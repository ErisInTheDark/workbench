/*
 * Exports:
 * - navigationActionBuilders: validate and build direct navigation and wait Browse actions. Keywords: browse, registry, navigation, wait, timeout.
 */
import {
  BROWSE_ACTION_NORMAL_TIMEOUT_MS,
  BROWSE_ACTION_SELECTOR_MAX_LENGTH,
  buildBrowserAction,
  normalizeActionString,
  normalizeActionTimeout,
  normalizePositiveActionInteger,
  type BrowseActionBuilder,
} from "./session-actions";

const LOAD_STATES = new Set(["load", "domcontentloaded", "networkidle"]);
const SELECTOR_STATES = new Set(["attached", "detached", "hidden", "visible"]);

export const navigationActionBuilders: readonly BrowseActionBuilder[] = [
  (action) => {
    if (action.action !== "back" && action.action !== "forward" && action.action !== "reload") return null;
    const waitUntil = action.wait && LOAD_STATES.has(action.wait) ? action.wait : "load";
    const timeoutMs = normalizeActionTimeout(action.timeoutMs, BROWSE_ACTION_NORMAL_TIMEOUT_MS);
    return buildBrowserAction(action.action, action, action.action, { timeoutMs, waitUntil }, [action.action, "--wait", waitUntil, "--timeout", String(timeoutMs)]);
  },
  (action) => {
    if (action.action !== "wait") return null;
    if (action.type !== "load" && action.type !== "selector" && action.type !== "timeout") {
      return { error: "Browse wait type must be load, selector, or timeout." };
    }
    const explicitDelay = action.type === "timeout" ? normalizePositiveActionInteger(action.ms) : null;
    const arg = explicitDelay ? String(explicitDelay) : normalizeActionString(action.argument, BROWSE_ACTION_SELECTOR_MAX_LENGTH);
    if (action.type === "selector" && !arg) return { error: "Browse wait selector requires a selector argument." };
    const state = action.state && SELECTOR_STATES.has(action.state) ? action.state : "visible";
    const operationTimeoutMs = normalizeActionTimeout(action.timeoutMs, BROWSE_ACTION_NORMAL_TIMEOUT_MS);
    const totalTimeoutMs = explicitDelay ? Math.max(operationTimeoutMs, explicitDelay + 5_000) : operationTimeoutMs;
    return buildBrowserAction("wait", action, "wait", {
      arg: arg ?? undefined,
      state,
      timeoutMs: operationTimeoutMs,
      type: action.type,
    }, ["wait", action.type, ...(arg ? [arg] : []), "--state", state, "--timeout", String(operationTimeoutMs)], { timeoutMs: totalTimeoutMs });
  },
];
