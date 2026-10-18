/*
 * Exports:
 * - WorkbenchBrowseCommandSpec: one BrowseMD command grammar and help entry.
 * - BROWSE_COMMAND_SPECS: authoritative BrowseMD command grammar.
 * - findWorkbenchBrowseCommandSpec: resolve command and subcommand tokens.
 * - renderWorkbenchBrowseHelp: render compact help from the grammar registry.
 */

export interface WorkbenchBrowseCommandSpec {
  flags: readonly string[];
  key: string;
  /** Positional arguments after the command key; null accepts free text. */
  maxArgs: number | null;
  usage: string;
}

const browserFlags = ["headless", "headed", "persistent", "s", "session"] as const;
const sessionFlags = ["s", "session"] as const;
const browser = (...flags: string[]) => [...browserFlags, ...flags];

export const BROWSE_COMMAND_SPECS: readonly WorkbenchBrowseCommandSpec[] = [
  { flags: browser("wait"), key: "back", maxArgs: 0, usage: "back [--wait <state>]" },
  { flags: browser(), key: "click", maxArgs: 1, usage: "click <selector|@ref>" },
  { flags: ["force"], key: "cleanup", maxArgs: null, usage: "cleanup [session ...] [--force]" },
  { flags: browser(), key: "cursor", maxArgs: 0, usage: "cursor" },
  { flags: sessionFlags, key: "doctor", maxArgs: 0, usage: "doctor" },
  { flags: browser(), key: "emulate device", maxArgs: 1, usage: "emulate device <iphone-14|pixel-7|clear>" },
  { flags: browser("press-enter"), key: "fill", maxArgs: 2, usage: "fill <selector|@ref> <value|\"\"> [--press-enter]" },
  { flags: sessionFlags, key: "forget", maxArgs: 0, usage: "forget" },
  { flags: browser("wait"), key: "forward", maxArgs: 0, usage: "forward [--wait <state>]" },
  { flags: browser(), key: "get", maxArgs: 2, usage: "get <kind> [selector|@ref]" },
  { flags: [], key: "help", maxArgs: null, usage: "help [command]" },
  { flags: browser("duration"), key: "highlight", maxArgs: 1, usage: "highlight <selector|@ref> [--duration <ms>]" },
  { flags: browser(), key: "is", maxArgs: 2, usage: "is <visible|checked> <selector|@ref>" },
  { flags: browser(), key: "key", maxArgs: null, usage: "key <name|chord>" },
  { flags: browser("button", "click-count", "return-xpath"), key: "mouse click", maxArgs: 2, usage: "mouse click <x> <y> [--button <button>] [--click-count <n>]" },
  { flags: browser("button", "delay", "return-xpath", "steps"), key: "mouse drag", maxArgs: 4, usage: "mouse drag <from-x> <from-y> <to-x> <to-y> [--steps <n>]" },
  { flags: browser("return-xpath"), key: "mouse hover", maxArgs: 2, usage: "mouse hover <x> <y>" },
  { flags: browser("interval", "park", "repeat", "return-xpath"), key: "mouse scroll", maxArgs: 4, usage: "mouse scroll <x> <y> <dx> <dy> [--repeat <n>] [--interval <ms>] [--park]" },
  { flags: browser("return-xpath"), key: "move cursor", maxArgs: 2, usage: "move cursor <x> <y>" },
  { flags: browser("wait"), key: "open", maxArgs: 1, usage: "open <url> [--wait <state>]" },
  { flags: browser(), key: "press", maxArgs: null, usage: "press <name|chord>" },
  { flags: browser(), key: "refs", maxArgs: 0, usage: "refs" },
  { flags: browser("wait"), key: "reload", maxArgs: 0, usage: "reload [--wait <state>]" },
  { flags: browser("animations", "full-page", "type"), key: "screenshot", maxArgs: 0, usage: "screenshot [--full-page] [--type <png|jpeg>]" },
  { flags: browser(), key: "select", maxArgs: 2, usage: "select <selector|@ref> <value>" },
  { flags: browser("compact", "filter", "max-depth"), key: "snapshot", maxArgs: 1, usage: "snapshot [selector|@ref] [--compact] [--filter <text|\"/regex/\">] [--max-depth <n>]" },
  { flags: sessionFlags, key: "status", maxArgs: 0, usage: "status" },
  { flags: [...sessionFlags, "force"], key: "stop", maxArgs: 0, usage: "stop [--force]" },
  { flags: browser(), key: "throttle cpu", maxArgs: 1, usage: "throttle cpu <rate|clear>" },
  { flags: browser(), key: "throttle network", maxArgs: 1, usage: "throttle network <slow-3g|fast-3g|offline|clear>" },
  { flags: browser("fling", "interval", "repeat", "speed"), key: "touch scroll", maxArgs: 4, usage: "touch scroll <x> <y> <dx> <dy> [--speed <n>] [--repeat <n>] [--interval <ms>] [--fling]" },
  { flags: browser(), key: "trace", maxArgs: 1, usage: "trace <start|stop>" },
  { flags: browser("delay", "mistakes"), key: "type", maxArgs: null, usage: "type <text> [--delay <ms>] [--mistakes]" },
  { flags: browser("scale"), key: "viewport", maxArgs: 2, usage: "viewport <width> <height> [--scale <n>]" },
  { flags: browser("state"), key: "wait", maxArgs: 3, usage: "wait <timeout|selector|load> ..." },
] as const;

const specsByKey = new Map(BROWSE_COMMAND_SPECS.map((spec) => [spec.key, spec]));

export function findWorkbenchBrowseCommandSpec(tokens: readonly string[]) {
  const first = tokens[0]?.toLowerCase() ?? "";
  const second = tokens[1]?.toLowerCase() ?? "";
  return specsByKey.get(`${first} ${second}`) ?? specsByKey.get(first) ?? null;
}

export function renderWorkbenchBrowseHelp(topic?: string | null) {
  const normalized = topic?.trim().toLowerCase() ?? "";
  if (normalized) {
    const matches = BROWSE_COMMAND_SPECS.filter((spec) => spec.key === normalized || spec.key.startsWith(`${normalized} `));
    if (!matches.length) return `Unknown BrowseMD help topic "${topic}".`;
    return matches.map((spec) => spec.usage).join("\n");
  }
  return BROWSE_COMMAND_SPECS.map((spec) => spec.usage).join("\n");
}
