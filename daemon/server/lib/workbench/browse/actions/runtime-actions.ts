/*
 * Exports:
 * - runtimeActionBuilders: validate and build direct screenshot Browse actions. Keywords: browse, registry, screenshot, runtime.
 */
import { buildBrowserAction, type BrowseActionBuilder } from "./session-actions";

export const runtimeActionBuilders: readonly BrowseActionBuilder[] = [
  (action) => {
    if (action.action !== "screenshot") return null;
    const type = action.type === "jpeg" ? "jpeg" : "png";
    const animations = action.animations === "allow" || action.animations === "disabled" ? action.animations : undefined;
    return buildBrowserAction("screenshot", action, "screenshot", {
      animations,
      fullPage: action.fullPage === true,
      type,
    }, ["screenshot", "--base64", ...(action.fullPage ? ["--full-page"] : []), ...(animations ? ["--animations", animations] : []), "--type", type], { timeoutMs: 15_000 });
  },
];
