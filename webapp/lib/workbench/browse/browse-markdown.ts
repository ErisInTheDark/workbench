/*
 * Exports:
 * - WorkbenchBrowseMarkdownCompileOptions: defaults applied to BrowseMD script actions. Keywords: browse, markdown, compile, defaults.
 * - WorkbenchBrowseMarkdownParseError: line-aware BrowseMD parse failure. Keywords: browse, markdown, parse, error.
 * - compileWorkbenchBrowseMarkdown: compile BrowseMD text into a typed Browse action sequence. Keywords: browse, markdown, typed actions.
 * - tokenizeWorkbenchBrowseMarkdownLine: split a BrowseMD command line with shell-ish quotes. Keywords: browse, markdown, shell, tokens.
 */
import type {
  WorkbenchBrowseAgentAction,
  WorkbenchBrowseAgentSequenceRequest,
  WorkbenchBrowseAgentWaitSelectorState,
  WorkbenchBrowseAgentWaitState,
  WorkbenchBrowseSessionMode,
} from "../../types";

export interface WorkbenchBrowseMarkdownCompileOptions {
  cwd: string;
  mode?: WorkbenchBrowseSessionMode | null;
  session?: string | null;
  streamProgress?: boolean | null;
  summary?: string | null;
  stopOnError?: boolean | null;
  threadId: string;
  timeoutMs?: number | null;
}

export class WorkbenchBrowseMarkdownParseError extends Error {
  constructor(message: string, readonly lineNumber: number) {
    super(`BrowseMD line ${lineNumber}: ${message}`);
    this.name = "WorkbenchBrowseMarkdownParseError";
  }
}

interface ParsedFence {
  language: string;
  lineNumber: number;
  lines: string[];
}

interface LineContext {
  lineNumber: number;
  options: WorkbenchBrowseMarkdownCompileOptions;
  tokens: string[];
}

const BROWSE_MARKDOWN_VALUE_FLAGS = new Set([
  "animations",
  "button",
  "click-count",
  "delay",
  "duration",
  "filter",
  "max-depth",
  "scale",
  "session",
  "steps",
  "type",
  "wait",
  "state",
  "s",
]);
const BROWSE_MARKDOWN_WAIT_STATES = new Set(["commit", "domcontentloaded", "load", "networkidle"]);
const BROWSE_MARKDOWN_SELECTOR_STATES = new Set(["attached", "detached", "hidden", "visible"]);
const BROWSE_MARKDOWN_GET_VALUES = new Set(["box", "checked", "html", "markdown", "text", "title", "url", "value", "visible"]);
const BROWSE_MARKDOWN_IS_CHECKS = new Set(["checked", "visible"]);
const BROWSE_MARKDOWN_MOUSE_BUTTONS = new Set(["left", "middle", "right"]);
const BROWSE_MARKDOWN_SCREENSHOT_ANIMATIONS = new Set(["allow", "disabled"]);
const BROWSE_MARKDOWN_SCREENSHOT_TYPES = new Set(["jpeg", "png"]);
const BROWSE_MARKDOWN_JAVASCRIPT_LANGUAGES = new Set(["js", "javascript"]);

export function compileWorkbenchBrowseMarkdown(
  script: string,
  options: WorkbenchBrowseMarkdownCompileOptions,
): WorkbenchBrowseAgentSequenceRequest {
  const actions: WorkbenchBrowseAgentAction[] = [];
  let activeFence: ParsedFence | null = null;
  const lines = normalizeLineEndings(script).split("\n");

  lines.forEach((line, lineIndex) => {
    const lineNumber = lineIndex + 1;
    const fenceLanguage = readFenceLanguage(line);
    if (activeFence) {
      if (fenceLanguage !== null) {
        actions.push(compileFence(activeFence, options));
        activeFence = null;
      } else {
        activeFence.lines.push(line);
      }
      return;
    }

    if (fenceLanguage !== null) {
      activeFence = {
        language: fenceLanguage,
        lineNumber,
        lines: [],
      };
      return;
    }

    const trimmedLine = line.trim();
    if (shouldIgnoreLine(trimmedLine)) {
      return;
    }

    const tokens = tokenizeWorkbenchBrowseMarkdownLine(line, lineNumber);
    if (!tokens.length) {
      return;
    }
    actions.push(compileCommandLine({ lineNumber, options, tokens }));
  });

  if (activeFence) {
    throw new WorkbenchBrowseMarkdownParseError("Unclosed fenced code block.", activeFence.lineNumber);
  }
  if (!actions.length) {
    throw new WorkbenchBrowseMarkdownParseError("BrowseMD script did not contain any actions.", 1);
  }

  return {
    actions,
    streamProgress: options.streamProgress ?? false,
    summary: options.summary ?? null,
    stopOnError: options.stopOnError ?? true,
  };
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n?/gu, "\n");
}

function readFenceLanguage(line: string) {
  const match = line.trim().match(/^```+\s*([A-Za-z0-9_-]*)\s*$/u);
  return match ? (match[1] ?? "").trim().toLowerCase() : null;
}

function shouldIgnoreLine(trimmedLine: string) {
  return !trimmedLine
    || trimmedLine === "---"
    || trimmedLine.startsWith("# ")
    || trimmedLine.startsWith("## ")
    || trimmedLine.startsWith("### ")
    || trimmedLine.startsWith("// ");
}

function compileFence(fence: ParsedFence, options: WorkbenchBrowseMarkdownCompileOptions): WorkbenchBrowseAgentAction {
  if (!BROWSE_MARKDOWN_JAVASCRIPT_LANGUAGES.has(fence.language)) {
    throw new WorkbenchBrowseMarkdownParseError(
      fence.language
        ? `Unsupported fenced code language "${fence.language}". Use js or javascript for Browse eval blocks.`
        : "Fenced code blocks must specify js or javascript for Browse eval blocks.",
      fence.lineNumber,
    );
  }

  const expression = createJavaScriptFenceExpression(fence.lines.join("\n").trim());
  if (!expression) {
    throw new WorkbenchBrowseMarkdownParseError("JavaScript eval block cannot be empty.", fence.lineNumber);
  }
  return {
    ...createBrowserActionBase(options, []),
    action: "eval",
    expression,
  };
}

function createJavaScriptFenceExpression(source: string) {
  if (!source) {
    return "";
  }
  if (!isJavaScriptFenceBody(source)) {
    return source;
  }
  return `(async () => {\n${source}\n})()`;
}

function isJavaScriptFenceBody(source: string) {
  return source.includes("\n")
    || /;\s*(?:$|\n)/u.test(source)
    || /\breturn\b/u.test(source);
}

function compileCommandLine(context: LineContext): WorkbenchBrowseAgentAction {
  const tokens = context.tokens[0]?.toLowerCase() === "browse" ? context.tokens.slice(1) : context.tokens;
  if (!tokens.length) {
    throw new WorkbenchBrowseMarkdownParseError("browse prefix requires a Browse command.", context.lineNumber);
  }
  const commandContext = { ...context, tokens };
  const [rawCommand = "", rawSecond = ""] = tokens;
  const command = rawCommand.toLowerCase();
  const second = rawSecond.toLowerCase();
  const args = getCommandArguments(tokens.slice(1));

  switch (command) {
    case "back":
    case "forward":
    case "reload":
      return {
        ...createBrowserActionBase(context.options, tokens),
        action: command,
        wait: readChoiceFlag(tokens, ["wait"], BROWSE_MARKDOWN_WAIT_STATES, "wait state", context.lineNumber) as WorkbenchBrowseAgentWaitState | null,
      };
    case "click":
      return {
        ...createBrowserActionBase(context.options, tokens),
        ...createTargetField(requireArgument(args, 0, "click requires a selector or ref.", context.lineNumber)),
        action: "click",
      };
    case "cleanup":
      return {
        ...createActionBase(context.options),
        action: "cleanup",
        force: hasFlag(tokens, ["force"]),
        sessions: args.length ? args : null,
      };
    case "cursor":
      return {
        ...createBrowserActionBase(context.options, tokens),
        action: "cursor",
      };
    case "doctor":
      return {
        ...createSessionActionBase(context.options, tokens),
        action: "doctor",
      };
    case "eval":
      return {
        ...createBrowserActionBase(context.options, tokens),
        action: "eval",
        expression: requireRest(args, 0, "eval requires a JavaScript expression.", context.lineNumber),
      };
    case "fill":
      return {
        ...createBrowserActionBase(context.options, tokens),
        ...createTargetField(requireArgument(args, 0, "fill requires a selector or ref.", context.lineNumber)),
        action: "fill",
        pressEnter: hasFlag(tokens, ["press-enter"]),
        value: requireRest(args, 1, "fill requires a value.", context.lineNumber),
      };
    case "forget":
      return compileForgetCommand(commandContext);
    case "get":
      return compileGetCommand(commandContext, args);
    case "highlight":
      return {
        ...createBrowserActionBase(context.options, tokens),
        ...createTargetField(requireArgument(args, 0, "highlight requires a selector or ref.", context.lineNumber)),
        action: "highlight",
        durationMs: readPositiveIntegerFlag(tokens, ["duration"], "duration", context.lineNumber),
      };
    case "is":
      return compileIsCommand(commandContext, args);
    case "js":
      return {
        ...createBrowserActionBase(context.options, tokens),
        action: "eval",
        expression: requireRest(args, 0, "js requires a JavaScript expression.", context.lineNumber),
      };
    case "key":
    case "press":
      return {
        ...createBrowserActionBase(context.options, tokens),
        action: "key",
        key: requireRest(args, 0, `${command} requires a key name or chord.`, context.lineNumber),
      };
    case "mouse":
      return compileMouseCommand(commandContext, second, getCommandArguments(tokens.slice(2)));
    case "move":
      return compileMoveCommand(commandContext, second, getCommandArguments(tokens.slice(2)));
    case "open":
      return {
        ...createBrowserActionBase(context.options, tokens),
        action: "open",
        url: requireArgument(args, 0, "open requires a URL.", context.lineNumber),
        wait: readChoiceFlag(tokens, ["wait"], BROWSE_MARKDOWN_WAIT_STATES, "wait state", context.lineNumber) as WorkbenchBrowseAgentWaitState | null,
      };
    case "refs":
      return {
        ...createBrowserActionBase(context.options, tokens),
        action: "refs",
      };
    case "screenshot":
      return {
        ...createBrowserActionBase(context.options, tokens),
        action: "screenshot",
        animations: readChoiceFlag(tokens, ["animations"], BROWSE_MARKDOWN_SCREENSHOT_ANIMATIONS, "screenshot animations", context.lineNumber) as "allow" | "disabled" | null,
        fullPage: hasFlag(tokens, ["full-page"]),
        type: readChoiceFlag(tokens, ["type"], BROWSE_MARKDOWN_SCREENSHOT_TYPES, "screenshot type", context.lineNumber) as "jpeg" | "png" | null,
      };
    case "select":
      return {
        ...createBrowserActionBase(context.options, tokens),
        ...createTargetField(requireArgument(args, 0, "select requires a selector or ref.", context.lineNumber)),
        action: "select",
        value: requireRest(args, 1, "select requires a value.", context.lineNumber),
      };
    case "snapshot":
      return {
        ...createBrowserActionBase(context.options, tokens),
        action: "snapshot",
        compact: hasFlag(tokens, ["compact"]) || args[0]?.toLowerCase() === "compact",
        filter: readStringFlag(tokens, ["filter"]),
        maxDepth: readPositiveIntegerFlag(tokens, ["max-depth"], "max-depth", context.lineNumber),
      };
    case "status":
      return {
        ...createSessionActionBase(context.options, tokens),
        action: "status",
      };
    case "stop":
      return {
        ...createSessionActionBase(context.options, tokens),
        action: "stop",
        force: hasFlag(tokens, ["force"]),
      };
    case "type":
      return {
        ...createBrowserActionBase(context.options, tokens),
        action: "type",
        delayMs: readPositiveIntegerFlag(tokens, ["delay"], "delay", context.lineNumber),
        mistakes: hasFlag(tokens, ["mistakes"]),
        text: requireRest(args, 0, "type requires text.", context.lineNumber),
      };
    case "viewport":
      return {
        ...createBrowserActionBase(context.options, tokens),
        action: "viewport",
        height: readRequiredNumber(args[1], "viewport requires a height.", context.lineNumber),
        scale: readPositiveNumberFlag(tokens, ["scale"], "scale", context.lineNumber),
        width: readRequiredNumber(args[0], "viewport requires a width.", context.lineNumber),
      };
    case "wait":
      return compileWaitCommand(commandContext, args);
    default:
      throw new WorkbenchBrowseMarkdownParseError(`Unsupported BrowseMD command "${rawCommand}".`, context.lineNumber);
  }
}

function compileForgetCommand(context: LineContext): WorkbenchBrowseAgentAction {
  if (hasFlag(context.tokens, ["force"])) {
    throw new WorkbenchBrowseMarkdownParseError("forget does not support --force.", context.lineNumber);
  }
  return {
    ...createSessionActionBase(context.options, context.tokens),
    action: "forget",
  };
}

function compileGetCommand(context: LineContext, args: string[]): WorkbenchBrowseAgentAction {
  const what = requireChoice(
    requireArgument(args, 0, "get requires a value kind.", context.lineNumber),
    BROWSE_MARKDOWN_GET_VALUES,
    "get value kind",
    context.lineNumber,
  ) as "box" | "checked" | "html" | "markdown" | "text" | "title" | "url" | "value" | "visible";
  const target = args[1] ? createTargetField(args[1]) : {};
  return {
    ...createBrowserActionBase(context.options, context.tokens),
    ...target,
    action: "get",
    what,
  };
}

function compileIsCommand(context: LineContext, args: string[]): WorkbenchBrowseAgentAction {
  const check = requireChoice(
    requireArgument(args, 0, "is requires a state check.", context.lineNumber),
    BROWSE_MARKDOWN_IS_CHECKS,
    "is state check",
    context.lineNumber,
  ) as "checked" | "visible";
  return {
    ...createBrowserActionBase(context.options, context.tokens),
    ...createTargetField(requireArgument(args, 1, "is requires a selector or ref.", context.lineNumber)),
    action: "is",
    check,
  };
}

function compileMoveCommand(context: LineContext, second: string, args: string[]): WorkbenchBrowseAgentAction {
  if (second !== "cursor") {
    throw new WorkbenchBrowseMarkdownParseError("move only supports `move cursor <x> <y>`.", context.lineNumber);
  }
  return createMouseHoverAction(context, args);
}

function compileMouseCommand(context: LineContext, subcommand: string, args: string[]): WorkbenchBrowseAgentAction {
  switch (subcommand) {
    case "click":
      return {
        ...createBrowserActionBase(context.options, context.tokens),
        action: "mouseClick",
        button: readChoiceFlag(context.tokens, ["button"], BROWSE_MARKDOWN_MOUSE_BUTTONS, "mouse button", context.lineNumber) as "left" | "middle" | "right" | null,
        clickCount: readPositiveIntegerFlag(context.tokens, ["click-count"], "click-count", context.lineNumber),
        returnXPath: hasFlag(context.tokens, ["return-xpath"]),
        x: readRequiredNumber(args[0], "mouse click requires an x coordinate.", context.lineNumber),
        y: readRequiredNumber(args[1], "mouse click requires a y coordinate.", context.lineNumber),
      };
    case "drag":
      return {
        ...createBrowserActionBase(context.options, context.tokens),
        action: "mouseDrag",
        button: readChoiceFlag(context.tokens, ["button"], BROWSE_MARKDOWN_MOUSE_BUTTONS, "mouse button", context.lineNumber) as "left" | "middle" | "right" | null,
        delayMs: readPositiveIntegerFlag(context.tokens, ["delay"], "delay", context.lineNumber),
        fromX: readRequiredNumber(args[0], "mouse drag requires a fromX coordinate.", context.lineNumber),
        fromY: readRequiredNumber(args[1], "mouse drag requires a fromY coordinate.", context.lineNumber),
        returnXPath: hasFlag(context.tokens, ["return-xpath"]),
        steps: readPositiveIntegerFlag(context.tokens, ["steps"], "steps", context.lineNumber),
        toX: readRequiredNumber(args[2], "mouse drag requires a toX coordinate.", context.lineNumber),
        toY: readRequiredNumber(args[3], "mouse drag requires a toY coordinate.", context.lineNumber),
      };
    case "hover":
      return createMouseHoverAction(context, args);
    case "scroll":
      return {
        ...createBrowserActionBase(context.options, context.tokens),
        action: "mouseScroll",
        deltaX: readRequiredNumber(args[2], "mouse scroll requires a deltaX value.", context.lineNumber),
        deltaY: readRequiredNumber(args[3], "mouse scroll requires a deltaY value.", context.lineNumber),
        returnXPath: hasFlag(context.tokens, ["return-xpath"]),
        x: readRequiredNumber(args[0], "mouse scroll requires an x coordinate.", context.lineNumber),
        y: readRequiredNumber(args[1], "mouse scroll requires a y coordinate.", context.lineNumber),
      };
    default:
      throw new WorkbenchBrowseMarkdownParseError("mouse supports click, drag, hover, or scroll.", context.lineNumber);
  }
}

function createMouseHoverAction(context: LineContext, args: string[]): WorkbenchBrowseAgentAction {
  return {
    ...createBrowserActionBase(context.options, context.tokens),
    action: "mouseHover",
    returnXPath: hasFlag(context.tokens, ["return-xpath"]),
    x: readRequiredNumber(args[0], "mouse hover requires an x coordinate.", context.lineNumber),
    y: readRequiredNumber(args[1], "mouse hover requires a y coordinate.", context.lineNumber),
  };
}

function compileWaitCommand(context: LineContext, args: string[]): WorkbenchBrowseAgentAction {
  const type = requireArgument(args, 0, "wait requires timeout, selector, or load.", context.lineNumber).toLowerCase();
  if (type === "timeout") {
    return {
      ...createBrowserActionBase(context.options, context.tokens),
      action: "wait",
      ms: readRequiredPositiveInteger(args[1], "wait timeout requires milliseconds.", context.lineNumber),
      type: "timeout",
    };
  }
  if (type === "selector") {
    return {
      ...createBrowserActionBase(context.options, context.tokens),
      action: "wait",
      argument: requireArgument(args, 1, "wait selector requires a selector.", context.lineNumber),
      state: args[2]
        ? requireChoice(args[2], BROWSE_MARKDOWN_SELECTOR_STATES, "selector wait state", context.lineNumber) as WorkbenchBrowseAgentWaitSelectorState
        : readChoiceFlag(context.tokens, ["state"], BROWSE_MARKDOWN_SELECTOR_STATES, "selector wait state", context.lineNumber) as WorkbenchBrowseAgentWaitSelectorState | null,
      type: "selector",
    };
  }
  if (type === "load") {
    return {
      ...createBrowserActionBase(context.options, context.tokens),
      action: "wait",
      argument: args[1]
        ? requireChoice(args[1], BROWSE_MARKDOWN_WAIT_STATES, "load wait state", context.lineNumber)
        : null,
      type: "load",
    };
  }
  throw new WorkbenchBrowseMarkdownParseError("wait type must be timeout, selector, or load.", context.lineNumber);
}

function createActionBase(options: WorkbenchBrowseMarkdownCompileOptions) {
  return {
    cwd: options.cwd,
    threadId: options.threadId,
    timeoutMs: options.timeoutMs ?? null,
  };
}

function createSessionActionBase(options: WorkbenchBrowseMarkdownCompileOptions, tokens: readonly string[]) {
  return {
    ...createActionBase(options),
    session: readStringFlag(tokens, ["session", "s"]) ?? options.session ?? null,
  };
}

function createBrowserActionBase(options: WorkbenchBrowseMarkdownCompileOptions, tokens: readonly string[]) {
  return {
    ...createSessionActionBase(options, tokens),
    mode: readMode(tokens) ?? options.mode ?? null,
    persistent: hasFlag(tokens, ["persistent"]) || null,
  };
}

function createTargetField(value: string) {
  return value.startsWith("@") ? { ref: value.slice(1) } : { selector: value };
}

function readMode(tokens: readonly string[]): WorkbenchBrowseSessionMode | null {
  if (hasFlag(tokens, ["headed"])) {
    return "headed";
  }
  if (hasFlag(tokens, ["headless"])) {
    return "headless";
  }
  return null;
}

export function tokenizeWorkbenchBrowseMarkdownLine(line: string, lineNumber: number) {
  const tokens: string[] = [];
  let token = "";
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }

  if (escaped) {
    token += "\\";
  }
  if (quote) {
    throw new WorkbenchBrowseMarkdownParseError("Unclosed quoted string.", lineNumber);
  }
  if (token) {
    tokens.push(token);
  }
  return tokens;
}

function getCommandArguments(tokens: readonly string[]) {
  const args: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const flag = readFlagName(token);
    if (flag) {
      if (!token.includes("=") && BROWSE_MARKDOWN_VALUE_FLAGS.has(flag)) {
        index += 1;
      }
      continue;
    }
    args.push(token);
  }
  return args;
}

function readFlagName(token: string) {
  if (!token.startsWith("-")) {
    return null;
  }
  const withoutPrefix = token.replace(/^-+/u, "");
  return (withoutPrefix.split("=", 1)[0] ?? "").trim().toLowerCase() || null;
}

function hasFlag(tokens: readonly string[], names: readonly string[]) {
  return tokens.some((token) => {
    const flag = readFlagName(token);
    return flag !== null && names.includes(flag);
  });
}

function readStringFlag(tokens: readonly string[], names: readonly string[]) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const flag = readFlagName(token);
    if (!flag || !names.includes(flag)) {
      continue;
    }
    const equalsIndex = token.indexOf("=");
    if (equalsIndex >= 0) {
      return token.slice(equalsIndex + 1).trim() || null;
    }
    return tokens[index + 1]?.trim() || null;
  }
  return null;
}

function readChoiceFlag<T extends string>(
  tokens: readonly string[],
  names: readonly string[],
  choices: ReadonlySet<T> | ReadonlySet<string>,
  label: string,
  lineNumber: number,
) {
  const value = readStringFlag(tokens, names);
  if (!value) {
    return null;
  }
  return requireChoice(value, choices, label, lineNumber);
}

function readPositiveIntegerFlag(tokens: readonly string[], names: readonly string[], label: string, lineNumber: number) {
  const value = readStringFlag(tokens, names);
  return value ? readRequiredPositiveInteger(value, `${label} must be a positive integer.`, lineNumber) : null;
}

function readPositiveNumberFlag(tokens: readonly string[], names: readonly string[], label: string, lineNumber: number) {
  const value = readStringFlag(tokens, names);
  if (!value) {
    return null;
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new WorkbenchBrowseMarkdownParseError(`${label} must be a positive number.`, lineNumber);
  }
  return numericValue;
}

function requireArgument(args: readonly string[], index: number, error: string, lineNumber: number) {
  const value = args[index]?.trim();
  if (!value) {
    throw new WorkbenchBrowseMarkdownParseError(error, lineNumber);
  }
  return value;
}

function requireRest(args: readonly string[], index: number, error: string, lineNumber: number) {
  const value = args.slice(index).join(" ").trim();
  if (!value) {
    throw new WorkbenchBrowseMarkdownParseError(error, lineNumber);
  }
  return value;
}

function requireChoice(value: string, choices: ReadonlySet<string>, label: string, lineNumber: number) {
  if (!choices.has(value)) {
    throw new WorkbenchBrowseMarkdownParseError(`${label} must be one of: ${[...choices].join(", ")}.`, lineNumber);
  }
  return value;
}

function readRequiredPositiveInteger(value: string | undefined, error: string, lineNumber: number) {
  const numericValue = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new WorkbenchBrowseMarkdownParseError(error, lineNumber);
  }
  return Math.trunc(numericValue);
}

function readRequiredNumber(value: string | undefined, error: string, lineNumber: number) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    throw new WorkbenchBrowseMarkdownParseError(error, lineNumber);
  }
  return Math.round(numericValue);
}
