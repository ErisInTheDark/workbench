/*
 * Exports:
 * - BrowseActionBuild/BrowseActionBuilder/BrowseRuntimeRequest: typed action-registry contracts for direct Browse runtime dispatch. Keywords: browse, action, registry, runtime, protocol.
 * - BROWSE_ACTION_* constants and normalization helpers: shared validation primitives for Browse action groups. Keywords: browse, validation, session, selector.
 * - sessionActionBuilders: build doctor, status, open, refs, cursor, stop, and viewport runtime actions. Keywords: browse, session, lifecycle, viewport.
 */
import type {
  WorkbenchBrowseAgentAction,
  WorkbenchBrowseAgentActionName,
  WorkbenchBrowseAgentSessionRequest,
  WorkbenchBrowseCommandRequest,
  WorkbenchBrowseSessionMode,
} from "workbench-shared/types";

export type BrowseJsonValue = boolean | number | string | null | BrowseJsonValue[] | { [key: string]: BrowseJsonValue };
export type BrowseRuntimeRequest =
  | { kind: "doctor"; session: string | null; timeoutMs: number }
  | { kind: "status"; session: string; timeoutMs: number }
  | { kind: "stop"; force: boolean; session: string; timeoutMs: number }
  | {
      kind: "open";
      mode: WorkbenchBrowseSessionMode;
      params: { timeoutMs: number; url: string; waitUntil: "load" | "domcontentloaded" | "networkidle" };
      persistent: boolean;
      session: string;
      timeoutMs: number;
    }
  | {
      command: string;
      kind: "command";
      mode: WorkbenchBrowseSessionMode | null;
      params: { [key: string]: BrowseJsonValue | undefined };
      persistent: boolean;
      session: string;
      timeoutMs: number;
    };

export interface BrowseActionBuild {
  action: Exclude<WorkbenchBrowseAgentActionName, "cleanup" | "forget" | "sessions">;
  args: string[];
  rememberSession: boolean;
  runtimeRequest: BrowseRuntimeRequest;
  session: string | null;
}

export type BrowseActionBuildResult = BrowseActionBuild | { error: string };
export type BrowseActionBuilder = (action: WorkbenchBrowseAgentAction) => BrowseActionBuildResult | null;

export interface WorkbenchBrowseAgentCommand extends BrowseActionBuild {
  commandRequest: WorkbenchBrowseCommandRequest;
}

export const BROWSE_ACTION_SESSION_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/u;
export const BROWSE_ACTION_SELECTOR_MAX_LENGTH = 4096;
export const BROWSE_ACTION_TEXT_MAX_LENGTH = 65_536;
export const BROWSE_ACTION_NORMAL_TIMEOUT_MS = 30_000;
export const BROWSE_ACTION_OPEN_TIMEOUT_MS = 60_000;
export const BROWSE_ACTION_STATUS_TIMEOUT_MS = 5_000;
const BROWSE_ACTION_URL_MAX_LENGTH = 8192;

export function normalizeActionString(value: object | string | number | boolean | null | undefined, maxLength: number) {
  const normalized = String(value ?? "").trim();
  return normalized && !normalized.includes("\0") && normalized.length <= maxLength ? normalized : null;
}

export function normalizeRequiredActionString(
  value: object | string | number | boolean | null | undefined,
  maxLength: number,
  error: string,
) {
  const normalized = normalizeActionString(value, maxLength);
  return normalized ? { ok: true as const, value: normalized } : { error, ok: false as const };
}

export function normalizeActionSession(value: string | null | undefined) {
  const session = String(value ?? "").trim();
  return session && BROWSE_ACTION_SESSION_PATTERN.test(session) ? session : null;
}

export function normalizeActionMode(value: WorkbenchBrowseSessionMode | null | undefined) {
  return value === "headed" || value === "headless" ? value : null;
}

export function normalizeActionSelector(request: { ref?: string | null; selector?: string | null }) {
  const selector = normalizeActionString(request.selector, BROWSE_ACTION_SELECTOR_MAX_LENGTH);
  if (selector) return selector;
  const ref = normalizeActionString(request.ref, BROWSE_ACTION_SELECTOR_MAX_LENGTH);
  return ref ? ref.startsWith("@") ? ref : `@${ref}` : null;
}

export function normalizeRequiredActionSelector(
  request: { ref?: string | null; selector?: string | null },
  error: string,
) {
  const selector = normalizeActionSelector(request);
  return selector ? { ok: true as const, value: selector } : { error, ok: false as const };
}

export function normalizePositiveActionInteger(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

export function normalizeFiniteActionNumber(value: number, error: string) {
  return Number.isFinite(value) ? { ok: true as const, value } : { error, ok: false as const };
}

export function normalizeActionTimeout(value: number | null | undefined, fallback: number) {
  const timeoutMs = normalizePositiveActionInteger(value);
  return timeoutMs ? Math.min(timeoutMs, 10 * 60_000) : fallback;
}

export function buildBrowserAction(
  action: BrowseActionBuild["action"],
  request: WorkbenchBrowseAgentSessionRequest,
  command: string,
  params: { [key: string]: BrowseJsonValue | undefined },
  args: string[],
  options: { rememberSession?: boolean; timeoutMs?: number } = {},
): BrowseActionBuildResult {
  if ("local" in request && request.local === false) {
    return { error: "Typed Workbench Browse requests only support local browser sessions." };
  }
  const session = normalizeActionSession(request.session);
  if (!session) return { error: "Typed Browse browser actions require a named session." };
  const mode = "mode" in request ? normalizeActionMode(request.mode as WorkbenchBrowseSessionMode | null | undefined) : null;
  const persistent = "persistent" in request && request.persistent === true;
  return {
    action,
    args: [...args, "--session", session, "--local", ...(mode ? [mode === "headed" ? "--headed" : "--headless"] : []), ...(persistent ? ["--persistent"] : [])],
    rememberSession: options.rememberSession === true,
    runtimeRequest: {
      command,
      kind: "command",
      mode,
      params,
      persistent,
      session,
      timeoutMs: normalizeActionTimeout(request.timeoutMs, options.timeoutMs ?? BROWSE_ACTION_NORMAL_TIMEOUT_MS),
    },
    session,
  };
}

export const sessionActionBuilders: readonly BrowseActionBuilder[] = [
  (action) => {
    if (action.action !== "doctor") return null;
    const session = normalizeActionSession(action.session);
    return {
      action: "doctor",
      args: ["doctor", "--json", ...(session ? ["--session", session] : [])],
      rememberSession: false,
      runtimeRequest: { kind: "doctor", session, timeoutMs: normalizeActionTimeout(action.timeoutMs, BROWSE_ACTION_STATUS_TIMEOUT_MS) },
      session,
    };
  },
  (action) => {
    if (action.action !== "status") return null;
    const session = normalizeActionSession(action.session);
    if (!session) return { error: "Typed Browse status requires a named session." };
    return {
      action: "status",
      args: ["status", "--session", session],
      rememberSession: false,
      runtimeRequest: { kind: "status", session, timeoutMs: normalizeActionTimeout(action.timeoutMs, BROWSE_ACTION_STATUS_TIMEOUT_MS) },
      session,
    };
  },
  (action) => {
    if (action.action !== "open") return null;
    const url = normalizeRequiredActionString(action.url, BROWSE_ACTION_URL_MAX_LENGTH, "Browse open requires a URL.");
    const session = normalizeActionSession(action.session);
    if (!url.ok) return { error: url.error };
    if (!session) return { error: "Typed Browse browser actions require a named session." };
    if (action.local === false) return { error: "Typed Workbench Browse requests only support local browser sessions." };
    const mode = normalizeActionMode(action.mode) ?? "headless";
    const waitUntil = action.wait === "domcontentloaded" || action.wait === "networkidle" ? action.wait : "load";
    const timeoutMs = normalizeActionTimeout(action.timeoutMs, BROWSE_ACTION_OPEN_TIMEOUT_MS);
    return {
      action: "open",
      args: ["open", url.value, "--session", session, "--local", mode === "headed" ? "--headed" : "--headless", ...(action.persistent ? ["--persistent"] : [])],
      rememberSession: true,
      runtimeRequest: {
        kind: "open",
        mode,
        params: { timeoutMs, url: url.value, waitUntil },
        persistent: action.persistent === true,
        session,
        timeoutMs,
      },
      session,
    };
  },
  (action) => action.action === "cursor" ? buildBrowserAction("cursor", action, "cursor", {}, ["cursor"]) : null,
  (action) => action.action === "refs" ? buildBrowserAction("refs", action, "refs", {}, ["refs"]) : null,
  (action) => {
    if (action.action !== "viewport") return null;
    const width = normalizePositiveActionInteger(action.width);
    const height = normalizePositiveActionInteger(action.height);
    if (!width || !height) return { error: "Browse viewport requires positive integer width and height." };
    const scale = typeof action.scale === "number" && Number.isFinite(action.scale) && action.scale > 0 ? action.scale : 1;
    return buildBrowserAction("viewport", action, "viewport", { height, scale, width }, ["viewport", String(width), String(height), "--scale", String(scale)]);
  },
  (action) => {
    if (action.action !== "stop") return null;
    const session = normalizeActionSession(action.session);
    if (!session) return { error: "Typed Browse stop requires a named session." };
    return {
      action: "stop",
      args: ["stop", "--session", session, ...(action.force ? ["--force"] : [])],
      rememberSession: false,
      runtimeRequest: { force: action.force === true, kind: "stop", session, timeoutMs: normalizeActionTimeout(action.timeoutMs, BROWSE_ACTION_STATUS_TIMEOUT_MS) },
      session,
    };
  },
];
