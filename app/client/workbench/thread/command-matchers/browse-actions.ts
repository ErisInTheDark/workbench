/*
 * Exports:
 * - BrowseActionInfo: one Browse step's BrowseMD action and display label.
 * - readBrowseAction: name a step from either vocabulary: BrowseMD words (`init-js`, `mouse`) or recorded result actions (`initScript`, `mouseClick`).
 */

export interface BrowseActionInfo {
  /** The BrowseMD command word the step ran. */
  action: string;
  label: string;
}

const COMMAND_LABELS: Readonly<Record<string, string>> = {
  back: "Back",
  cleanup: "Clean up",
  click: "Click",
  cursor: "Cursor",
  doctor: "Diagnostics",
  emulate: "Emulate",
  eval: "Evaluate",
  fill: "Fill",
  forget: "Forget persistent profile",
  forward: "Forward",
  get: "Read",
  help: "Help",
  highlight: "Highlight",
  "init-js": "Install page script",
  is: "Check",
  key: "Press key",
  mouse: "Mouse",
  open: "Open",
  refs: "Refs",
  reload: "Reload",
  screenshot: "Screenshot",
  select: "Select",
  sessions: "Sessions",
  snapshot: "Snapshot",
  status: "Status",
  stop: "Stop",
  throttle: "Throttle",
  touch: "Touch",
  trace: "Trace",
  type: "Type",
  viewport: "Viewport",
  wait: "Wait",
};

/** Recorded results name the agent action, which splits some BrowseMD commands by their subcommand. */
const RECORDED_ACTIONS: Readonly<Record<string, BrowseActionInfo>> = {
  emulateDevice: { action: "emulate", label: "Emulate device" },
  initScript: { action: "init-js", label: "Install page script" },
  mouseClick: { action: "mouse", label: "Mouse click" },
  mouseDrag: { action: "mouse", label: "Mouse drag" },
  mouseHover: { action: "mouse", label: "Mouse hover" },
  mouseScroll: { action: "mouse", label: "Mouse scroll" },
  throttleCpu: { action: "throttle", label: "Throttle CPU" },
  throttleNetwork: { action: "throttle", label: "Throttle network" },
  touchScroll: { action: "touch", label: "Touch scroll" },
};

export function readBrowseAction(name: string): BrowseActionInfo {
  return RECORDED_ACTIONS[name] ?? {
    action: name,
    label: COMMAND_LABELS[name] ?? (name.replace(/[-_]+/gu, " ").replace(/^./u, character => character.toUpperCase()) || "Browse step"),
  };
}
