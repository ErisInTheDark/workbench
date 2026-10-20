/*
 * Exports:
 * - BROWSE_DEVICE_PRESETS: supported device-emulation presets.
 * - BROWSE_NETWORK_PRESETS: supported network-throttling presets.
 * - BROWSE_COLOR_SCHEMES: supported prefers-color-scheme overrides.
 * - performanceActionBuilders: validate and build emulation, throttling, and trace Browse actions.
 */
import type {
  WorkbenchBrowseColorScheme,
  WorkbenchBrowseDevicePreset,
  WorkbenchBrowseNetworkPreset,
} from "workbench-shared/types";
import {
  buildBrowserAction,
  normalizeFiniteActionNumber,
  type BrowseActionBuilder,
} from "./session-actions";

export const BROWSE_DEVICE_PRESETS: ReadonlySet<string> = new Set<WorkbenchBrowseDevicePreset>(["clear", "iphone-14", "pixel-7"]);
export const BROWSE_NETWORK_PRESETS: ReadonlySet<string> = new Set<WorkbenchBrowseNetworkPreset>(["clear", "fast-3g", "offline", "slow-3g"]);
export const BROWSE_COLOR_SCHEMES: ReadonlySet<string> = new Set<WorkbenchBrowseColorScheme>(["clear", "dark", "light"]);

export const performanceActionBuilders: readonly BrowseActionBuilder[] = [
  (action) => {
    if (action.action !== "emulateDevice") return null;
    if (!BROWSE_DEVICE_PRESETS.has(action.preset)) return { error: "Browse emulateDevice requires a supported preset." };
    return buildBrowserAction("emulateDevice", action, "workbench.emulateDevice", {
      preset: action.preset,
    }, ["emulate", "device", action.preset]);
  },
  (action) => {
    if (action.action !== "emulateColorScheme") return null;
    if (!BROWSE_COLOR_SCHEMES.has(action.scheme)) return { error: "Browse emulateColorScheme requires light, dark, or clear." };
    return buildBrowserAction("emulateColorScheme", action, "workbench.emulateColorScheme", {
      scheme: action.scheme,
    }, ["emulate", "color-scheme", action.scheme]);
  },
  (action) => {
    if (action.action !== "throttleCpu") return null;
    if (action.rate === null) {
      return buildBrowserAction("throttleCpu", action, "workbench.throttleCpu", { rate: 1 }, ["throttle", "cpu", "clear"]);
    }
    const rate = normalizeFiniteActionNumber(action.rate, "Browse throttleCpu requires a finite rate.");
    if (!rate.ok || rate.value < 1) return { error: "Browse throttleCpu requires a rate of at least 1 or clear." };
    return buildBrowserAction("throttleCpu", action, "workbench.throttleCpu", { rate: rate.value }, ["throttle", "cpu", String(rate.value)]);
  },
  (action) => {
    if (action.action !== "throttleNetwork") return null;
    if (!BROWSE_NETWORK_PRESETS.has(action.preset)) return { error: "Browse throttleNetwork requires a supported preset." };
    return buildBrowserAction("throttleNetwork", action, "workbench.throttleNetwork", {
      preset: action.preset,
    }, ["throttle", "network", action.preset]);
  },
  (action) => {
    if (action.action !== "trace") return null;
    if (action.operation !== "start" && action.operation !== "stop") return { error: "Browse trace requires start or stop." };
    return buildBrowserAction("trace", action, "workbench.trace", {
      operation: action.operation,
    }, ["trace", action.operation]);
  },
];
