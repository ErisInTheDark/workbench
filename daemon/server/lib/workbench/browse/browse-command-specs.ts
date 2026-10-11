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
  usage: string;
}

const browserFlags = ["headless", "headed", "persistent", "s", "session"] as const;
const sessionFlags = ["s", "session"] as const;
const browser = (...flags: string[]) => [...browserFlags, ...flags];

export const BROWSE_COMMAND_SPECS: readonly WorkbenchBrowseCommandSpec[] = [
  { flags: browser("wait"), key: "back", usage: "back [--wait <state>]" },
  { flags: browser(), key: "click", usage: "click <selector|@ref>" },
  { flags: ["force"], key: "cleanup", usage: "cleanup [session ...] [--force]" },
  { flags: browser(), key: "cursor", usage: "cursor" },
  { flags: sessionFlags, key: "doctor", usage: "doctor" },
  { flags: browser(), key: "emulate device", usage: "emulate device <iphone-14|pixel-7|clear>" },
  { flags: browser("press-enter"), key: "fill", usage: "fill <selector|@ref> <value> [--press-enter]" },
  { flags: sessionFlags, key: "forget", usage: "forget" },
  { flags: browser("wait"), key: "forward", usage: "forward [--wait <state>]" },
  { flags: browser(), key: "get", usage: "get <kind> [selector|@ref]" },
  { flags: [], key: "help", usage: "help [command]" },
  { flags: browser("duration"), key: "highlight", usage: "highlight <selector|@ref> [--duration <ms>]" },
  { flags: browser(), key: "is", usage: "is <visible|checked> <selector|@ref>" },
  { flags: browser(), key: "key", usage: "key <name|chord>" },
  { flags: browser("button", "click-count", "return-xpath"), key: "mouse click", usage: "mouse click <x> <y> [--button <button>] [--click-count <n>]" },
  { flags: browser("button", "delay", "return-xpath", "steps"), key: "mouse drag", usage: "mouse drag <from-x> <from-y> <to-x> <to-y> [--steps <n>]" },
  { flags: browser("return-xpath"), key: "mouse hover", usage: "mouse hover <x> <y>" },
  { flags: browser("interval", "park", "repeat", "return-xpath"), key: "mouse scroll", usage: "mouse scroll <x> <y> <dx> <dy> [--repeat <n>] [--interval <ms>] [--park]" },
  { flags: browser("return-xpath"), key: "move cursor", usage: "move cursor <x> <y>" },
  { flags: browser("wait"), key: "open", usage: "open <url> [--wait <state>]" },
  { flags: browser(), key: "press", usage: "press <name|chord>" },
  { flags: browser(), key: "refs", usage: "refs" },
  { flags: browser("wait"), key: "reload", usage: "reload [--wait <state>]" },
  { flags: browser("animations", "full-page", "type"), key: "screenshot", usage: "screenshot [--full-page] [--type <png|jpeg>]" },
  { flags: browser(), key: "select", usage: "select <selector|@ref> <value>" },
  { flags: browser("compact", "filter", "max-depth"), key: "snapshot", usage: "snapshot [selector|@ref] [--compact] [--filter <pattern>] [--max-depth <n>]" },
  { flags: sessionFlags, key: "status", usage: "status" },
  { flags: [...sessionFlags, "force"], key: "stop", usage: "stop [--force]" },
  { flags: browser(), key: "throttle cpu", usage: "throttle cpu <rate|clear>" },
  { flags: browser(), key: "throttle network", usage: "throttle network <slow-3g|fast-3g|offline|clear>" },
  { flags: browser("fling", "interval", "repeat", "speed"), key: "touch scroll", usage: "touch scroll <x> <y> <dx> <dy> [--speed <n>] [--repeat <n>] [--interval <ms>] [--fling]" },
  { flags: browser(), key: "trace", usage: "trace <start|stop>" },
  { flags: browser("delay", "mistakes"), key: "type", usage: "type <text> [--delay <ms>] [--mistakes]" },
  { flags: browser("scale"), key: "viewport", usage: "viewport <width> <height> [--scale <n>]" },
  { flags: browser("state"), key: "wait", usage: "wait <timeout|selector|load> ..." },
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
