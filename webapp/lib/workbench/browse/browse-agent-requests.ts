/*
 * Exports:
 * - WorkbenchBrowseAgentCommand: normalized typed Browse action plus raw Browse command arguments. Keywords: browse, agent, api, command.
 * - WorkbenchBrowseAgentCleanupCommand: normalized typed Browse cleanup request. Keywords: browse, agent, cleanup, sessions.
 * - WorkbenchBrowseAgentRequestNormalization: validation result for typed Browse agent requests. Keywords: browse, agent, normalize, validation.
 * - normalizeWorkbenchBrowseAgentRequest: convert a typed Workbench Browse agent request into safe Browse CLI arguments. Keywords: browse, agent, api, args.
 */
import type {
  WorkbenchBrowseAgentAction,
  WorkbenchBrowseAgentActionName,
  WorkbenchBrowseAgentBrowserRequest,
  WorkbenchBrowseAgentCleanupRequest,
  WorkbenchBrowseAgentForgetRequest,
  WorkbenchBrowseCommandRequest,
  WorkbenchBrowseSessionMode,
} from "../../types";

const BROWSE_AGENT_SESSION_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/u;
const BROWSE_AGENT_THREAD_PATTERN = /^[A-Za-z0-9_-]+$/u;
const BROWSE_AGENT_SELECTOR_MAX_LENGTH = 4096;
const BROWSE_AGENT_TEXT_MAX_LENGTH = 65_536;
const BROWSE_AGENT_URL_MAX_LENGTH = 8192;
const BROWSE_AGENT_ALLOWED_WAIT_STATES = new Set(["commit", "domcontentloaded", "load", "networkidle"]);
const BROWSE_AGENT_ALLOWED_SELECTOR_STATES = new Set(["attached", "detached", "hidden", "visible"]);
const BROWSE_AGENT_ALLOWED_WAIT_TYPES = new Set(["load", "selector", "timeout"]);
const BROWSE_AGENT_ALLOWED_GET_VALUES = new Set(["box", "checked", "html", "markdown", "text", "title", "url", "value", "visible"]);
const BROWSE_AGENT_ALLOWED_IS_CHECKS = new Set(["checked", "visible"]);
const BROWSE_AGENT_ALLOWED_MOUSE_BUTTONS = new Set(["left", "middle", "right"]);

type WorkbenchBrowseCliAgentAction = Exclude<WorkbenchBrowseAgentAction, WorkbenchBrowseAgentCleanupRequest | WorkbenchBrowseAgentForgetRequest>;

export interface WorkbenchBrowseAgentCommand {
  action: Exclude<WorkbenchBrowseAgentActionName, "cleanup" | "forget">;
  commandRequest: WorkbenchBrowseCommandRequest;
  mode: WorkbenchBrowseSessionMode | null;
  rememberSession: boolean;
  session: string | null;
}

export interface WorkbenchBrowseAgentCleanupCommand {
  action: "cleanup";
  cwd?: string | null;
  force: boolean;
  projectId?: string | null;
  sessions: string[] | null;
  threadId: string;
  timeoutMs?: number | null;
}

export interface WorkbenchBrowseAgentForgetCommand {
  action: "forget";
  cwd?: string | null;
  projectId?: string | null;
  session: string;
  threadId: string;
  timeoutMs?: number | null;
}

export type WorkbenchBrowseAgentRequestNormalization =
  | {
    command: WorkbenchBrowseAgentCleanupCommand;
    ok: true;
  }
  | {
    command: WorkbenchBrowseAgentForgetCommand;
    ok: true;
  }
  | {
    command: WorkbenchBrowseAgentCommand;
    ok: true;
  }
  | {
    error: string;
    ok: false;
  };

interface WorkbenchBrowseAgentRequestWithSession {
  session?: string | null;
}

export function normalizeWorkbenchBrowseAgentRequest(value: WorkbenchBrowseAgentAction): WorkbenchBrowseAgentRequestNormalization {
  const action = value.action;
  switch (action) {
    case "doctor":
      return normalizeCommand(value, buildDoctorArgs(value));
    case "status":
      return normalizeCommand(value, buildSessionOnlyArgs("status", value, { requireSession: false }));
    case "open":
      return normalizeCommand(value, buildOpenArgs(value), { rememberSession: true });
    case "snapshot":
      return normalizeCommand(value, buildSnapshotArgs(value));
    case "click":
      return normalizeCommand(value, buildSelectorArgs("click", value));
    case "cursor":
      return normalizeCommand(value, buildBrowserArgs("cursor", value));
    case "fill":
      return normalizeCommand(value, buildFillArgs(value));
    case "forget":
      return normalizeForget(value);
    case "eval":
      return normalizeCommand(value, buildEvalArgs(value));
    case "get":
      return normalizeCommand(value, buildGetArgs(value));
    case "highlight":
      return normalizeCommand(value, buildHighlightArgs(value));
    case "is":
      return normalizeCommand(value, buildIsArgs(value));
    case "type":
      return normalizeCommand(value, buildTypeArgs(value));
    case "key":
      return normalizeCommand(value, buildKeyArgs(value));
    case "mouseClick":
      return normalizeCommand(value, buildMouseClickArgs(value));
    case "mouseDrag":
      return normalizeCommand(value, buildMouseDragArgs(value));
    case "mouseHover":
      return normalizeCommand(value, buildMouseHoverArgs(value));
    case "mouseScroll":
      return normalizeCommand(value, buildMouseScrollArgs(value));
    case "select":
      return normalizeCommand(value, buildSelectArgs(value));
    case "wait":
      return normalizeCommand(value, buildWaitArgs(value));
    case "back":
    case "forward":
    case "reload":
      return normalizeCommand(value, buildNavigationArgs(action, value));
    case "screenshot":
      return normalizeCommand(value, buildScreenshotArgs(value));
    case "refs":
      return normalizeCommand(value, buildBrowserArgs("refs", value));
    case "viewport":
      return normalizeCommand(value, buildViewportArgs(value));
    case "stop":
      return normalizeCommand(value, buildStopArgs(value));
    case "cleanup":
      return normalizeCleanup(value);
    default:
      return {
        error: "Unsupported Browse agent action.",
        ok: false,
      };
  }
}

function normalizeCommand(
  request: WorkbenchBrowseCliAgentAction,
  argsResult: string[] | { error: string },
  { rememberSession = false }: { rememberSession?: boolean } = {},
): WorkbenchBrowseAgentRequestNormalization {
  if (!Array.isArray(argsResult)) {
    return {
      error: argsResult.error,
      ok: false,
    };
  }

  const threadId = normalizeThreadId(request.threadId);
  if (!threadId) {
    return {
      error: "Typed Browse requests require a valid threadId.",
      ok: false,
    };
  }

  const session = "session" in request ? normalizeSessionName(request.session) : null;
  return {
    command: {
      action: request.action,
      commandRequest: {
        args: argsResult,
        cwd: request.cwd ?? null,
        projectId: request.projectId ?? null,
        threadId,
        timeoutMs: request.timeoutMs ?? null,
      },
      mode: "mode" in request ? normalizeMode(request.mode) : null,
      rememberSession,
      session,
    },
    ok: true,
  };
}

function normalizeForget(request: Extract<WorkbenchBrowseAgentAction, { action: "forget" }>): WorkbenchBrowseAgentRequestNormalization {
  const threadId = normalizeThreadId(request.threadId);
  if (!threadId) {
    return {
      error: "Typed Browse forget requires a valid threadId.",
      ok: false,
    };
  }

  if ("force" in request) {
    return {
      error: "Typed Browse forget does not support force.",
      ok: false,
    };
  }

  const session = normalizeSessionName(request.session);
  if (!session) {
    return {
      error: "Typed Browse forget requires a valid named session.",
      ok: false,
    };
  }

  return {
    command: {
      action: "forget",
      cwd: request.cwd ?? null,
      projectId: request.projectId ?? null,
      session,
      threadId,
      timeoutMs: request.timeoutMs ?? null,
    },
    ok: true,
  };
}

function normalizeCleanup(request: WorkbenchBrowseAgentCleanupRequest): WorkbenchBrowseAgentRequestNormalization {
  const threadId = normalizeThreadId(request.threadId);
  if (!threadId) {
    return {
      error: "Typed Browse cleanup requires a valid threadId.",
      ok: false,
    };
  }

  const requestedSessions = (request as { sessions?: unknown }).sessions;
  const sessions = requestedSessions === null || requestedSessions === undefined
    ? null
    : Array.isArray(requestedSessions)
      ? normalizeSessionList(requestedSessions)
      : false;
  if (sessions === false) {
    return {
      error: "Browse cleanup sessions must be valid named Browse sessions.",
      ok: false,
    };
  }

  return {
    command: {
      action: "cleanup",
      cwd: request.cwd ?? null,
      force: request.force === true,
      projectId: request.projectId ?? null,
      sessions,
      threadId,
      timeoutMs: request.timeoutMs ?? null,
    },
    ok: true,
  };
}

function buildDoctorArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "doctor" }>) {
  const args = ["doctor"];
  if (request.json !== false) {
    args.push("--json");
  }
  appendSessionArgs(args, request, { requireSession: false });
  return args;
}

function buildOpenArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "open" }>) {
  const url = normalizeRequiredString(request.url, BROWSE_AGENT_URL_MAX_LENGTH, "Browse open requires a URL.");
  if (!url.ok) {
    return { error: url.error };
  }

  const args = ["open", url.value];
  const sessionError = appendBrowserSessionArgs(args, request, { defaultMode: "headless" });
  if (sessionError) {
    return sessionError;
  }
  const wait = normalizeOptionalChoice(request.wait, BROWSE_AGENT_ALLOWED_WAIT_STATES, "Browse open wait state is invalid.");
  if (!wait.ok) {
    return { error: wait.error };
  }
  if (wait.value) {
    args.push("--wait", wait.value);
  }
  return args;
}

function buildSnapshotArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "snapshot" }>) {
  const args = ["snapshot"];
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }
  if (request.compact) {
    args.push("--compact");
  }
  const filter = normalizeOptionalString(request.filter, BROWSE_AGENT_SELECTOR_MAX_LENGTH);
  if (filter) {
    args.push("--filter", filter);
  }
  if (isPositiveInteger(request.maxDepth)) {
    args.push("--max-depth", String(Math.trunc(request.maxDepth)));
  }
  return args;
}

function buildSelectorArgs(command: "click", request: Extract<WorkbenchBrowseAgentAction, { action: "click" }>) {
  const target = normalizeRequiredSelectorOrRef(request, `Browse ${command} requires a selector or snapshot ref.`);
  if (!target.ok) {
    return { error: target.error };
  }
  const args = [command, target.value];
  const sessionError = appendBrowserSessionArgs(args, request);
  return sessionError ?? args;
}

function buildFillArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "fill" }>) {
  const selector = normalizeRequiredSelectorOrRef(request, "Browse fill requires a selector or snapshot ref.");
  const value = normalizeRequiredString(request.value, BROWSE_AGENT_TEXT_MAX_LENGTH, "Browse fill requires a value.");
  if (!selector.ok) {
    return { error: selector.error };
  }
  if (!value.ok) {
    return { error: value.error };
  }
  const args = ["fill", selector.value, value.value];
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }
  if (request.pressEnter) {
    args.push("--press-enter");
  }
  return args;
}

function buildEvalArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "eval" }>) {
  const expression = normalizeRequiredString(request.expression, BROWSE_AGENT_TEXT_MAX_LENGTH, "Browse eval requires a JavaScript expression.");
  if (!expression.ok) {
    return { error: expression.error };
  }
  const args = ["eval", expression.value];
  const sessionError = appendBrowserSessionArgs(args, request);
  return sessionError ?? args;
}

function buildGetArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "get" }>) {
  const what = normalizeRequiredChoice(request.what, BROWSE_AGENT_ALLOWED_GET_VALUES, "Browse get requires a valid value kind.");
  if (!what.ok) {
    return { error: what.error };
  }
  const args = ["get", what.value];
  const selector = normalizeOptionalSelectorOrRef(request);
  if (selector) {
    args.push(selector);
  }
  const sessionError = appendBrowserSessionArgs(args, request);
  return sessionError ?? args;
}

function buildHighlightArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "highlight" }>) {
  const selector = normalizeRequiredSelectorOrRef(request, "Browse highlight requires a selector or snapshot ref.");
  if (!selector.ok) {
    return { error: selector.error };
  }
  const args = ["highlight", selector.value];
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }
  if (isPositiveInteger(request.durationMs)) {
    args.push("--duration", String(Math.trunc(request.durationMs)));
  }
  return args;
}

function buildIsArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "is" }>) {
  const check = normalizeRequiredChoice(request.check, BROWSE_AGENT_ALLOWED_IS_CHECKS, "Browse is requires a valid state check.");
  const selector = normalizeRequiredSelectorOrRef(request, "Browse is requires a selector or snapshot ref.");
  if (!check.ok) {
    return { error: check.error };
  }
  if (!selector.ok) {
    return { error: selector.error };
  }
  const args = ["is", check.value, selector.value];
  const sessionError = appendBrowserSessionArgs(args, request);
  return sessionError ?? args;
}

function buildTypeArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "type" }>) {
  const text = normalizeRequiredString(request.text, BROWSE_AGENT_TEXT_MAX_LENGTH, "Browse type requires text.");
  if (!text.ok) {
    return { error: text.error };
  }
  const args = ["type", text.value];
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }
  if (isPositiveInteger(request.delayMs)) {
    args.push("--delay", String(Math.trunc(request.delayMs)));
  }
  if (request.mistakes) {
    args.push("--mistakes");
  }
  return args;
}

function buildKeyArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "key" }>) {
  const key = normalizeRequiredString(request.key, 256, "Browse key requires a key name or chord.");
  if (!key.ok) {
    return { error: key.error };
  }
  const args = ["key", key.value];
  const sessionError = appendBrowserSessionArgs(args, request);
  return sessionError ?? args;
}

function buildMouseClickArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "mouseClick" }>) {
  const x = normalizeCoordinate(request.x, "Browse mouseClick requires a finite x coordinate.");
  const y = normalizeCoordinate(request.y, "Browse mouseClick requires a finite y coordinate.");
  if (!x.ok) {
    return { error: x.error };
  }
  if (!y.ok) {
    return { error: y.error };
  }

  const args = ["mouse", "click", String(x.value), String(y.value)];
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }

  const button = normalizeOptionalChoice(request.button, BROWSE_AGENT_ALLOWED_MOUSE_BUTTONS, "Browse mouseClick button must be left, middle, or right.");
  if (!button.ok) {
    return { error: button.error };
  }
  if (button.value) {
    args.push("--button", button.value);
  }
  if (isPositiveInteger(request.clickCount)) {
    args.push("--click-count", String(Math.trunc(request.clickCount)));
  }
  if (request.returnXPath) {
    args.push("--return-xpath");
  }
  return args;
}

function buildMouseHoverArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "mouseHover" }>) {
  const x = normalizeCoordinate(request.x, "Browse mouseHover requires a finite x coordinate.");
  const y = normalizeCoordinate(request.y, "Browse mouseHover requires a finite y coordinate.");
  if (!x.ok) {
    return { error: x.error };
  }
  if (!y.ok) {
    return { error: y.error };
  }

  const args = ["mouse", "hover", String(x.value), String(y.value)];
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }
  if (request.returnXPath) {
    args.push("--return-xpath");
  }
  return args;
}

function buildMouseDragArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "mouseDrag" }>) {
  const fromX = normalizeCoordinate(request.fromX, "Browse mouseDrag requires a finite fromX coordinate.");
  const fromY = normalizeCoordinate(request.fromY, "Browse mouseDrag requires a finite fromY coordinate.");
  const toX = normalizeCoordinate(request.toX, "Browse mouseDrag requires a finite toX coordinate.");
  const toY = normalizeCoordinate(request.toY, "Browse mouseDrag requires a finite toY coordinate.");
  if (!fromX.ok) {
    return { error: fromX.error };
  }
  if (!fromY.ok) {
    return { error: fromY.error };
  }
  if (!toX.ok) {
    return { error: toX.error };
  }
  if (!toY.ok) {
    return { error: toY.error };
  }

  const args = ["mouse", "drag", String(fromX.value), String(fromY.value), String(toX.value), String(toY.value)];
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }

  const button = normalizeOptionalChoice(request.button, BROWSE_AGENT_ALLOWED_MOUSE_BUTTONS, "Browse mouseDrag button must be left, middle, or right.");
  if (!button.ok) {
    return { error: button.error };
  }
  if (button.value) {
    args.push("--button", button.value);
  }
  if (isPositiveInteger(request.delayMs)) {
    args.push("--delay", String(Math.trunc(request.delayMs)));
  }
  if (request.returnXPath) {
    args.push("--return-xpath");
  }
  if (isPositiveInteger(request.steps)) {
    args.push("--steps", String(Math.trunc(request.steps)));
  }
  return args;
}

function buildMouseScrollArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "mouseScroll" }>) {
  const x = normalizeCoordinate(request.x, "Browse mouseScroll requires a finite x coordinate.");
  const y = normalizeCoordinate(request.y, "Browse mouseScroll requires a finite y coordinate.");
  const deltaX = normalizeCoordinate(request.deltaX, "Browse mouseScroll requires a finite deltaX value.");
  const deltaY = normalizeCoordinate(request.deltaY, "Browse mouseScroll requires a finite deltaY value.");
  if (!x.ok) {
    return { error: x.error };
  }
  if (!y.ok) {
    return { error: y.error };
  }
  if (!deltaX.ok) {
    return { error: deltaX.error };
  }
  if (!deltaY.ok) {
    return { error: deltaY.error };
  }

  const args = ["mouse", "scroll", String(x.value), String(y.value), String(deltaX.value), String(deltaY.value)];
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }
  if (request.returnXPath) {
    args.push("--return-xpath");
  }
  return args;
}

function buildSelectArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "select" }>) {
  const selector = normalizeRequiredSelectorOrRef(request, "Browse select requires a selector or snapshot ref.");
  const value = normalizeRequiredString(request.value, BROWSE_AGENT_TEXT_MAX_LENGTH, "Browse select requires a value.");
  if (!selector.ok) {
    return { error: selector.error };
  }
  if (!value.ok) {
    return { error: value.error };
  }
  const args = ["select", selector.value, value.value];
  const sessionError = appendBrowserSessionArgs(args, request);
  return sessionError ?? args;
}

function buildWaitArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "wait" }>) {
  const waitType = normalizeRequiredChoice(request.type, BROWSE_AGENT_ALLOWED_WAIT_TYPES, "Browse wait type must be load, selector, or timeout.");
  if (!waitType.ok) {
    return { error: waitType.error };
  }
  const args = ["wait", waitType.value];
  const argument = waitType.value === "timeout" && isPositiveInteger(request.ms)
    ? String(Math.trunc(request.ms))
    : normalizeOptionalString(request.argument, BROWSE_AGENT_SELECTOR_MAX_LENGTH);
  if (argument) {
    args.push(argument);
  }
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }
  const state = normalizeOptionalChoice(request.state, BROWSE_AGENT_ALLOWED_SELECTOR_STATES, "Browse wait selector state is invalid.");
  if (!state.ok) {
    return { error: state.error };
  }
  if (state.value) {
    args.push("--state", state.value);
  }
  return args;
}

function buildNavigationArgs(
  command: "back" | "forward" | "reload",
  request: Extract<WorkbenchBrowseAgentAction, { action: "back" | "forward" | "reload" }>,
) {
  const args: string[] = [command];
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }
  const wait = normalizeOptionalChoice(request.wait, BROWSE_AGENT_ALLOWED_WAIT_STATES, `Browse ${command} wait state is invalid.`);
  if (!wait.ok) {
    return { error: wait.error };
  }
  if (wait.value) {
    args.push("--wait", wait.value);
  }
  return args;
}

function buildScreenshotArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "screenshot" }>) {
  const args = ["screenshot", "--base64"];
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }
  if (request.fullPage) {
    args.push("--full-page");
  }
  if (request.animations) {
    args.push("--animations", request.animations);
  }
  if (request.type) {
    args.push("--type", request.type);
  }
  return args;
}

function buildViewportArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "viewport" }>) {
  if (!isPositiveInteger(request.width) || !isPositiveInteger(request.height)) {
    return { error: "Browse viewport requires positive integer width and height." };
  }

  const args = ["viewport", String(Math.trunc(request.width)), String(Math.trunc(request.height))];
  const sessionError = appendBrowserSessionArgs(args, request);
  if (sessionError) {
    return sessionError;
  }
  if (typeof request.scale === "number" && Number.isFinite(request.scale) && request.scale > 0) {
    args.push("--scale", String(request.scale));
  }
  return args;
}

function buildStopArgs(request: Extract<WorkbenchBrowseAgentAction, { action: "stop" }>) {
  const args = ["stop"];
  const sessionError = appendSessionArgs(args, request, { requireSession: true });
  if (sessionError) {
    return sessionError;
  }
  if (request.force) {
    args.push("--force");
  }
  return args;
}

function buildSessionOnlyArgs(
  command: "status",
  request: WorkbenchBrowseAgentRequestWithSession,
  { requireSession }: { requireSession: boolean },
) {
  const args = [command];
  const sessionError = appendSessionArgs(args, request, { requireSession });
  return sessionError ?? args;
}

function buildBrowserArgs(command: "cursor" | "refs", request: WorkbenchBrowseAgentBrowserRequest) {
  const args = [command];
  const sessionError = appendBrowserSessionArgs(args, request);
  return sessionError ?? args;
}

function appendBrowserSessionArgs(
  args: string[],
  request: WorkbenchBrowseAgentBrowserRequest,
  { defaultMode = null }: { defaultMode?: WorkbenchBrowseSessionMode | null } = {},
) {
  if (request.local === false) {
    return { error: "Typed Workbench Browse requests only support local browser sessions." };
  }

  const sessionError = appendSessionArgs(args, request, { requireSession: true });
  if (sessionError) {
    return sessionError;
  }

  args.push("--local");
  const mode = normalizeMode(request.mode) ?? defaultMode;
  if (mode) {
    args.push(mode === "headed" ? "--headed" : "--headless");
  }
  if (request.persistent === true) {
    args.push("--persistent");
  }
  return null;
}

function appendSessionArgs(
  args: string[],
  request: WorkbenchBrowseAgentRequestWithSession,
  { requireSession }: { requireSession: boolean },
) {
  const session = normalizeSessionName(request.session);
  if (!session && requireSession) {
    return { error: "Typed Browse browser actions require a named session." };
  }
  if (session) {
    args.push("--session", session);
  }
  return null;
}

function normalizeSessionName(value: string | null | undefined) {
  const session = String(value ?? "").trim();
  return session && BROWSE_AGENT_SESSION_PATTERN.test(session) ? session : null;
}

function normalizeThreadId(value: string | null | undefined) {
  const threadId = String(value ?? "").trim();
  return threadId && BROWSE_AGENT_THREAD_PATTERN.test(threadId) ? threadId : null;
}

function normalizeSessionList(values: unknown[]) {
  const sessions = values.map(normalizeSessionName).filter((session): session is string => Boolean(session));
  if (sessions.length !== values.length) {
    return false;
  }
  return [...new Set(sessions)];
}

function normalizeMode(value: WorkbenchBrowseSessionMode | null | undefined) {
  return value === "headed" || value === "headless" ? value : null;
}

function normalizeRequiredString(value: unknown, maxLength: number, error: string) {
  const normalizedValue = normalizeOptionalString(value, maxLength);
  return normalizedValue
    ? { ok: true as const, value: normalizedValue }
    : { error, ok: false as const };
}

function normalizeRequiredSelectorOrRef(
  request: { ref?: string | null; selector?: string | null },
  error: string,
) {
  const target = normalizeOptionalSelectorOrRef(request);
  return target
    ? { ok: true as const, value: target }
    : { error, ok: false as const };
}

function normalizeOptionalSelectorOrRef(request: { ref?: string | null; selector?: string | null }) {
  const selector = normalizeOptionalString(request.selector, BROWSE_AGENT_SELECTOR_MAX_LENGTH);
  if (selector) {
    return selector;
  }

  const ref = normalizeOptionalString(request.ref, BROWSE_AGENT_SELECTOR_MAX_LENGTH);
  if (!ref) {
    return null;
  }
  return ref.startsWith("@") ? ref : `@${ref}`;
}

function normalizeOptionalString(value: unknown, maxLength: number) {
  const normalizedValue = String(value ?? "").trim();
  if (!normalizedValue || normalizedValue.includes("\0") || normalizedValue.length > maxLength) {
    return null;
  }
  return normalizedValue;
}

function normalizeRequiredChoice<T extends string>(
  value: T | null | undefined,
  choices: ReadonlySet<string>,
  error: string,
) {
  const normalizedValue = String(value ?? "").trim();
  return choices.has(normalizedValue)
    ? { ok: true as const, value: normalizedValue }
    : { error, ok: false as const };
}

function normalizeOptionalChoice<T extends string>(
  value: T | null | undefined,
  choices: ReadonlySet<string>,
  error: string,
) {
  if (value === null || value === undefined || value === "") {
    return { ok: true as const, value: null };
  }
  return normalizeRequiredChoice(value, choices, error);
}

function isPositiveInteger(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeCoordinate(value: unknown, error: string) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue)
    ? { ok: true as const, value: Math.round(numberValue) }
    : { error, ok: false as const };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
