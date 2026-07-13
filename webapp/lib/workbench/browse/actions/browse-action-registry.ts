/*
 * Exports:
 * - WorkbenchBrowseAgentCleanupCommand/WorkbenchBrowseAgentForgetCommand/WorkbenchBrowseAgentRequestNormalization: normalized typed Browse action contracts. Keywords: browse, action, registry, cleanup, forget.
 * - normalizeWorkbenchBrowseAgentRequest: validate a typed Browse request through grouped action builders and emit direct runtime metadata. Keywords: browse, registry, validation, runtime.
 */
import type { WorkbenchBrowseAgentAction, WorkbenchBrowseAgentCleanupRequest } from "../../../types";
import { elementInputActionBuilders } from "./element-input-actions";
import { mouseActionBuilders } from "./mouse-actions";
import { navigationActionBuilders } from "./navigation-actions";
import { runtimeActionBuilders } from "./runtime-actions";
import {
  BROWSE_ACTION_SESSION_PATTERN,
  normalizeActionSession,
  sessionActionBuilders,
  type WorkbenchBrowseAgentCommand,
} from "./session-actions";

const THREAD_PATTERN = /^[A-Za-z0-9_-]+$/u;
const ACTION_BUILDERS = [
  ...sessionActionBuilders,
  ...navigationActionBuilders,
  ...elementInputActionBuilders,
  ...mouseActionBuilders,
  ...runtimeActionBuilders,
];

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
  | { command: WorkbenchBrowseAgentCleanupCommand; ok: true }
  | { command: WorkbenchBrowseAgentForgetCommand; ok: true }
  | { command: WorkbenchBrowseAgentCommand; ok: true }
  | { error: string; ok: false };

function normalizeThreadId(value: string | null | undefined) {
  const threadId = String(value ?? "").trim();
  return threadId && THREAD_PATTERN.test(threadId) ? threadId : null;
}

function normalizeCleanup(request: WorkbenchBrowseAgentCleanupRequest): WorkbenchBrowseAgentRequestNormalization {
  const threadId = normalizeThreadId(request.threadId);
  if (!threadId) return { error: "Typed Browse cleanup requires a valid threadId.", ok: false };
  const requested = request.sessions;
  let sessions: string[] | null = null;
  if (requested !== null && requested !== undefined) {
    if (!Array.isArray(requested)) return { error: "Browse cleanup sessions must be valid named Browse sessions.", ok: false };
    sessions = requested.map((session) => normalizeActionSession(session)).filter((session): session is string => Boolean(session));
    if (sessions.length !== requested.length) return { error: "Browse cleanup sessions must be valid named Browse sessions.", ok: false };
    sessions = [...new Set(sessions)];
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

export function normalizeWorkbenchBrowseAgentRequest(value: WorkbenchBrowseAgentAction): WorkbenchBrowseAgentRequestNormalization {
  const threadId = normalizeThreadId(value.threadId);
  if (!threadId) return { error: "Typed Browse requests require a valid threadId.", ok: false };
  if (value.action === "cleanup") return normalizeCleanup(value);
  if (value.action === "forget") {
    const session = normalizeActionSession(value.session);
    if (!session || !BROWSE_ACTION_SESSION_PATTERN.test(session)) {
      return { error: "Typed Browse forget requires a valid named session.", ok: false };
    }
    return {
      command: {
        action: "forget",
        cwd: value.cwd ?? null,
        projectId: value.projectId ?? null,
        session,
        threadId,
        timeoutMs: value.timeoutMs ?? null,
      },
      ok: true,
    };
  }
  for (const builder of ACTION_BUILDERS) {
    const built = builder(value);
    if (!built) continue;
    if ("error" in built) return { error: built.error, ok: false };
    return {
      command: {
        ...built,
        commandRequest: {
          args: built.args,
          cwd: value.cwd ?? null,
          projectId: value.projectId ?? null,
          threadId,
          timeoutMs: value.timeoutMs ?? null,
        },
      },
      ok: true,
    };
  }
  return { error: "Unsupported Browse agent action.", ok: false };
}

export type { BrowseRuntimeRequest, WorkbenchBrowseAgentCommand } from "./session-actions";
