/*
 * Exports:
 * - elementInputActionBuilders: validate and build direct element, text-input, evaluation, snapshot, and selection Browse actions. Keywords: browse, registry, element, input, snapshot.
 */
import type { WorkbenchBrowseAgentAction } from "workbench-shared/types";
import {
  BROWSE_ACTION_NORMAL_TIMEOUT_MS,
  BROWSE_ACTION_SELECTOR_MAX_LENGTH,
  BROWSE_ACTION_TEXT_MAX_LENGTH,
  buildBrowserAction,
  normalizeActionSelector,
  normalizeActionString,
  normalizePositiveActionInteger,
  normalizeRequiredActionSelector,
  normalizeRequiredActionString,
  type BrowseActionBuilder,
} from "./session-actions";

const GET_VALUES = new Set(["box", "checked", "html", "markdown", "text", "title", "url", "value", "visible"]);

function buildClick(action: Extract<WorkbenchBrowseAgentAction, { action: "click" }>) {
  const selector = normalizeRequiredActionSelector(action, "Browse click requires a selector or snapshot ref.");
  return selector.ok
    ? buildBrowserAction("click", action, "click", { selector: selector.value }, ["click", selector.value])
    : { error: selector.error };
}

export const elementInputActionBuilders: readonly BrowseActionBuilder[] = [
  (action) => action.action === "click" ? buildClick(action) : null,
  (action) => {
    if (action.action !== "fill") return null;
    const selector = normalizeRequiredActionSelector(action, "Browse fill requires a selector or snapshot ref.");
    const value = normalizeRequiredActionString(action.value, BROWSE_ACTION_TEXT_MAX_LENGTH, "Browse fill requires a value.");
    if (!selector.ok) return { error: selector.error };
    if (!value.ok) return { error: value.error };
    return buildBrowserAction("fill", action, "fill", {
      pressEnter: action.pressEnter === true,
      selector: selector.value,
      value: value.value,
    }, ["fill", selector.value, value.value, ...(action.pressEnter ? ["--press-enter"] : [])]);
  },
  (action) => {
    if (action.action !== "eval") return null;
    const expression = normalizeRequiredActionString(action.expression, BROWSE_ACTION_TEXT_MAX_LENGTH, "Browse eval requires a JavaScript expression.");
    return expression.ok
      ? buildBrowserAction("eval", action, "eval", { expression: expression.value }, ["eval", expression.value])
      : { error: expression.error };
  },
  (action) => {
    if (action.action !== "get") return null;
    if (!GET_VALUES.has(action.what)) return { error: "Browse get requires a valid value kind." };
    const selector = normalizeActionSelector(action);
    return buildBrowserAction("get", action, "get", { selector: selector ?? undefined, what: action.what }, ["get", action.what, ...(selector ? [selector] : [])]);
  },
  (action) => {
    if (action.action !== "highlight") return null;
    const selector = normalizeRequiredActionSelector(action, "Browse highlight requires a selector or snapshot ref.");
    if (!selector.ok) return { error: selector.error };
    const durationMs = normalizePositiveActionInteger(action.durationMs) ?? 2_000;
    return buildBrowserAction("highlight", action, "highlight", { durationMs, selector: selector.value }, ["highlight", selector.value, "--duration", String(durationMs)]);
  },
  (action) => {
    if (action.action !== "is") return null;
    const selector = normalizeRequiredActionSelector(action, "Browse is requires a selector or snapshot ref.");
    if (!selector.ok) return { error: selector.error };
    if (action.check !== "checked" && action.check !== "visible") return { error: "Browse is requires a valid state check." };
    return buildBrowserAction("is", action, "is", { check: action.check, selector: selector.value }, ["is", action.check, selector.value]);
  },
  (action) => {
    if (action.action !== "type") return null;
    const text = normalizeRequiredActionString(action.text, BROWSE_ACTION_TEXT_MAX_LENGTH, "Browse type requires text.");
    if (!text.ok) return { error: text.error };
    const delay = normalizePositiveActionInteger(action.delayMs);
    return buildBrowserAction("type", action, "type", {
      delay: delay ?? undefined,
      mistakes: action.mistakes === true,
      text: text.value,
    }, ["type", text.value, ...(delay ? ["--delay", String(delay)] : []), ...(action.mistakes ? ["--mistakes"] : [])]);
  },
  (action) => {
    if (action.action !== "key") return null;
    const key = normalizeRequiredActionString(action.key, 256, "Browse key requires a key name or chord.");
    return key.ok
      ? buildBrowserAction("key", action, "key", { key: key.value }, ["key", key.value])
      : { error: key.error };
  },
  (action) => {
    if (action.action !== "select") return null;
    const selector = normalizeRequiredActionSelector(action, "Browse select requires a selector or snapshot ref.");
    const value = normalizeRequiredActionString(action.value, BROWSE_ACTION_TEXT_MAX_LENGTH, "Browse select requires a value.");
    if (!selector.ok) return { error: selector.error };
    if (!value.ok) return { error: value.error };
    return buildBrowserAction("select", action, "select", { selector: selector.value, values: [value.value] }, ["select", selector.value, value.value]);
  },
  (action) => {
    if (action.action !== "snapshot") return null;
    const filter = normalizeActionString(action.filter, BROWSE_ACTION_SELECTOR_MAX_LENGTH);
    const maxDepth = normalizePositiveActionInteger(action.maxDepth);
    return buildBrowserAction("snapshot", action, "snapshot", {
      compact: action.compact === true,
      filter: filter ?? undefined,
      maxDepth: maxDepth ?? undefined,
    }, ["snapshot", ...(action.compact ? ["--compact"] : []), ...(filter ? ["--filter", filter] : []), ...(maxDepth ? ["--max-depth", String(maxDepth)] : [])], {
      timeoutMs: BROWSE_ACTION_NORMAL_TIMEOUT_MS,
    });
  },
];
