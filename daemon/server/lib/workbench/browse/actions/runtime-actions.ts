/*
 * Exports:
 * - runtimeActionBuilders: validate and build direct page or element screenshot Browse actions.
 */
import { buildBrowserAction, normalizeActionSelector, type BrowseActionBuilder } from "./session-actions";

export const runtimeActionBuilders: readonly BrowseActionBuilder[] = [
  (action) => {
    if (action.action !== "screenshot") return null;
    const type = action.type === "jpeg" ? "jpeg" : "png";
    const animations = action.animations === "allow" || action.animations === "disabled" ? action.animations : undefined;
    const target = normalizeActionSelector(action);
    if (target && action.fullPage) return { error: "Browse screenshot captures either one element or the full page, not both." };
    return buildBrowserAction("screenshot", action, "screenshot", {
      animations,
      fullPage: action.fullPage === true,
      target: target ?? undefined,
      type,
    }, [
      "screenshot", ...(target ? [target] : []), "--base64", ...(action.fullPage ? ["--full-page"] : []),
      ...(animations ? ["--animations", animations] : []), "--type", type,
    ], { timeoutMs: 15_000 });
  },
];
