/*
 * Exports:
 * - default WorkbenchBrowseSessionController: list, stop, forget, and stale-clean Workbench-owned Browse sessions. Keywords: browse, session, lifecycle, cleanup.
 */
import type {
  WorkbenchBrowseAgentResponse,
  WorkbenchBrowseCommandResponse,
  WorkbenchBrowseSessionControlRequest,
  WorkbenchBrowseSessionControlResponse,
  WorkbenchBrowseSessionLifecycleState,
  WorkbenchBrowseSessionListRequest,
  WorkbenchBrowseSessionListResponse,
  WorkbenchBrowseSessionMode,
  WorkbenchBrowseSessionSource,
  WorkbenchBrowseSessionSummary,
} from "../../types";
import WorkbenchBrowseCli from "./WorkbenchBrowseCli";
import WorkbenchBrowseProfileStore from "./WorkbenchBrowseProfileStore";
import WorkbenchBrowseSessionRegistry, { type WorkbenchBrowseSessionRecord } from "./WorkbenchBrowseSessionRegistry";

const DEFAULT_BROWSE_TIMEOUT_MS = 120_000;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/u;

interface BrowseStatusPayload {
  browserConnected?: boolean;
  initialized?: boolean;
  mode?: WorkbenchBrowseSessionMode | string | null;
  pages?: unknown[];
  pid?: number;
  session?: string;
  target?: {
    headless?: boolean;
    kind?: string;
  };
}

export default class WorkbenchBrowseSessionController {
  private readonly cli: WorkbenchBrowseCli;
  private readonly profileStore: WorkbenchBrowseProfileStore;
  private readonly registry: WorkbenchBrowseSessionRegistry;

  constructor({
    cli = new WorkbenchBrowseCli(),
    profileStore = new WorkbenchBrowseProfileStore(),
    registry = new WorkbenchBrowseSessionRegistry(),
  }: {
    cli?: WorkbenchBrowseCli;
    profileStore?: WorkbenchBrowseProfileStore;
    registry?: WorkbenchBrowseSessionRegistry;
  } = {}) {
    this.cli = cli;
    this.profileStore = profileStore;
    this.registry = registry;
  }

  async cleanupStaleInactiveSessions({
    olderThanMs,
    readThreadActive,
  }: {
    olderThanMs: number;
    readThreadActive: (threadId: string) => Promise<boolean | null>;
  }) {
    const threadIds = await this.registry.listOwnedThreadIds();
    for (const threadId of threadIds) {
      const active = await readThreadActive(threadId);
      if (active === null) {
        continue;
      }

      if (active) {
        await this.registry.markThreadActive(threadId);
      } else {
        await this.registry.markThreadInactive(threadId);
      }
    }

    const staleSessions = await this.registry.listStaleInactiveSessions({
      olderThanMs,
    });
    for (const session of staleSessions) {
      if (!session.threadId) {
        continue;
      }

      await this.stopSession({
        action: "stop",
        force: true,
        projectId: session.projectId,
        session: session.name,
        threadId: session.threadId,
      });
    }
  }

  async cleanupThreadSessions({
    cwd,
    force,
    projectId,
    sessions,
    threadId,
    timeoutMs,
  }: {
    cwd?: string | null;
    force: boolean;
    projectId?: string | null;
    sessions: string[] | null;
    threadId: string;
    timeoutMs?: number | null;
  }): Promise<WorkbenchBrowseAgentResponse> {
    const startedAt = Date.now();
    const registeredSessions = sessions ?? (await this.registry.listByThreadId(threadId)).map((session) => session.name);
    const sessionNames = [...new Set(registeredSessions)];
    const cleanupResults: WorkbenchBrowseCommandResponse[] = [];

    for (const session of sessionNames) {
      const result = await this.stopSession({
        action: "stop",
        cwd: cwd ?? null,
        force,
        projectId: projectId ?? null,
        session,
        threadId,
        timeoutMs: timeoutMs ?? null,
      });
      if (result.result) {
        cleanupResults.push(result.result);
      }
    }

    const ok = cleanupResults.every((result) => result.ok);
    return {
      action: "cleanup",
      cleanupResults,
      durationMs: Date.now() - startedAt,
      exitCode: ok ? 0 : null,
      ok,
      stderr: cleanupResults.map((result) => result.stderr).filter(Boolean).join("\n"),
      stdout: JSON.stringify({
        cleanedSessions: cleanupResults.filter((result) => result.ok).length,
        sessions: sessionNames,
      }, null, 2),
    };
  }

  async forgetSession(sessionName: string) {
    if (!isValidSessionName(sessionName)) {
      throw new Error("Browse session name is invalid.");
    }
    await this.registry.forget(sessionName);
  }

  async forgetPersistentSession({
    cwd,
    projectId,
    session,
    threadId,
    timeoutMs,
  }: {
    cwd?: string | null;
    projectId?: string | null;
    session: string;
    threadId: string;
    timeoutMs?: number | null;
  }): Promise<WorkbenchBrowseAgentResponse> {
    if (!isValidSessionName(session)) {
      throw new Error("Browse session name is invalid.");
    }

    const startedAt = Date.now();
    const stopResult = await this.stopSession({
      action: "stop",
      cwd: cwd ?? null,
      force: false,
      projectId: projectId ?? null,
      session,
      threadId,
      timeoutMs: timeoutMs ?? null,
    });
    if (stopResult.result && !stopResult.result.ok) {
      return {
        action: "forget",
        durationMs: Date.now() - startedAt,
        error: stopResult.result.error ?? "Unable to stop Browse session before forgetting its persistent profile.",
        exitCode: stopResult.result.exitCode,
        ok: false,
        stderr: stopResult.result.stderr,
        stdout: stopResult.result.stdout,
        timedOut: stopResult.result.timedOut,
      };
    }

    const forgottenProfile = await this.profileStore.forgetPersistentSession(session);
    await this.registry.forget(session);
    return {
      action: "forget",
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: JSON.stringify({
        forgotPersistentProfile: Boolean(forgottenProfile),
        profilePath: forgottenProfile?.profilePath ?? null,
        session,
        stopped: stopResult.stopped,
      }, null, 2),
    };
  }

  async listSessions(request: WorkbenchBrowseSessionListRequest): Promise<WorkbenchBrowseSessionListResponse> {
    const executionContext = await this.cli.resolveExecutionContext({
      cwd: request.cwd ?? null,
      projectId: request.projectId ?? null,
    });
    const includeRuntime = request.includeRuntime !== false;
    const records = request.threadId
      ? await this.registry.listByThreadId(request.threadId)
      : executionContext.projectId
        ? await this.registry.listByProjectId(executionContext.projectId)
        : await this.registry.list();
    const recordsByName = new Map(records.map((record) => [record.name, record]));
    const runtimeSessionNames = includeRuntime ? await this.cli.listRuntimeSessionNames() : [];
    const sessionNames = [...new Set([
      ...records.map((record) => record.name),
      ...runtimeSessionNames.filter((sessionName) => !executionContext.projectId || recordsByName.has(sessionName)),
    ])].sort((left, right) => left.localeCompare(right));

    const sessions = await Promise.all(sessionNames.map((sessionName) => (
      this.buildSessionSummary(sessionName, recordsByName.get(sessionName) ?? null, {
        cwd: request.cwd ?? null,
        projectId: request.projectId ?? executionContext.projectId,
        threadId: request.threadId ?? null,
      }, runtimeSessionNames.includes(sessionName))
    )));

    return {
      generatedAt: new Date().toISOString(),
      projectId: executionContext.projectId,
      sessions,
    };
  }

  async rememberSession({
    cwd,
    mode,
    name,
    projectId,
    projectRootPath,
    threadId,
  }: {
    cwd: string | null;
    mode: WorkbenchBrowseSessionMode | null;
    name: string;
    projectId: string | null;
    projectRootPath: string | null;
    threadId: string;
  }) {
    await this.registry.remember({
      cwd,
      mode,
      name,
      projectId,
      projectRootPath,
      threadId,
    });
  }

  async stopSession(request: WorkbenchBrowseSessionControlRequest): Promise<WorkbenchBrowseSessionControlResponse> {
    if (!isValidSessionName(request.session)) {
      throw new Error("Browse session name is invalid.");
    }

    const projectContext = await this.cli.resolveExecutionContext({
      cwd: request.cwd ?? null,
      projectId: request.projectId ?? null,
    });
    const existing = (await this.registry.list()).find((session) => session.name === request.session) ?? null;
    if (existing?.projectId && projectContext.projectId && existing.projectId !== projectContext.projectId) {
      throw new Error("Browse session belongs to a different project.");
    }

    if (request.action === "forget") {
      await this.registry.forget(request.session);
      return {
        result: null,
        session: null,
        stopped: false,
      };
    }

    const args = ["stop", "--session", request.session];
    if (request.force) {
      args.push("--force");
    }
    const result = await this.cli.run({
      args,
      cwd: request.cwd ?? projectContext.cwd,
      projectId: request.projectId ?? projectContext.projectId,
      threadId: request.threadId ?? existing?.threadId ?? "browse-session-ui",
      timeoutMs: request.timeoutMs ?? DEFAULT_BROWSE_TIMEOUT_MS,
    });
    if (result.ok) {
      await this.registry.forget(request.session);
    }

    return {
      result,
      session: result.ok
        ? null
        : await this.buildSessionSummary(request.session, existing, {
          cwd: request.cwd ?? null,
          projectId: request.projectId ?? projectContext.projectId,
          threadId: request.threadId ?? existing?.threadId ?? null,
        }, true),
      stopped: result.ok,
    };
  }

  private async buildSessionSummary(
    sessionName: string,
    record: WorkbenchBrowseSessionRecord | null,
    request: {
      cwd: string | null;
      projectId: string | null;
      threadId: string | null;
    },
    hasRuntimeFiles: boolean,
  ): Promise<WorkbenchBrowseSessionSummary> {
    const statusResult = await this.cli.runStatus(sessionName, {
      cwd: request.cwd ?? record?.cwd ?? null,
      projectId: request.projectId ?? record?.projectId ?? null,
      threadId: request.threadId ?? record?.threadId ?? "browse-session-list",
    });
    const status = parseBrowseStatus(statusResult);
    const pid = status.pid ?? await this.cli.readRuntimePid(sessionName).catch(() => null);
    return {
      browserConnected: status.browserConnected,
      cwd: record?.cwd ?? null,
      inactiveSince: record?.inactiveSince ?? null,
      initialized: status.initialized,
      lastActionAt: record?.lastActionAt ?? null,
      mode: record?.mode ?? status.mode,
      name: sessionName,
      pid,
      projectId: record?.projectId ?? null,
      projectRootPath: record?.projectRootPath ?? null,
      source: getSessionSource(Boolean(record), hasRuntimeFiles),
      state: getSessionState({
        hasRecord: Boolean(record),
        hasRuntimeFiles,
        status,
        statusResult,
      }),
      statusError: status.error ?? statusResult.error ?? null,
      threadId: record?.threadId ?? null,
    };
  }
}

function getSessionSource(hasRecord: boolean, hasRuntimeFiles: boolean): WorkbenchBrowseSessionSource {
  if (hasRecord && hasRuntimeFiles) {
    return "registry-and-runtime";
  }
  return hasRecord ? "registry" : "runtime";
}

function getSessionState({
  hasRecord,
  hasRuntimeFiles,
  status,
  statusResult,
}: {
  hasRecord: boolean;
  hasRuntimeFiles: boolean;
  status: ReturnType<typeof parseBrowseStatus>;
  statusResult: WorkbenchBrowseCommandResponse;
}): WorkbenchBrowseSessionLifecycleState {
  if (status.browserConnected || status.initialized) {
    return "running";
  }
  if (!hasRecord && hasRuntimeFiles) {
    return "orphan";
  }
  if (!statusResult.ok || status.error || statusResult.timedOut) {
    return hasRuntimeFiles ? "stale" : "unknown";
  }
  if (hasRecord) {
    return "stopped";
  }
  return "unknown";
}

function isValidSessionName(value: string) {
  return SESSION_NAME_PATTERN.test(value);
}

function normalizeMode(value: unknown) {
  return value === "headed" || value === "headless" ? value : null;
}

function parseBrowseStatus(result: WorkbenchBrowseCommandResponse): {
  browserConnected: boolean | null;
  error: string | null;
  initialized: boolean | null;
  mode: WorkbenchBrowseSessionMode | null;
  pid: number | null;
} {
  if (!result.ok) {
    return {
      browserConnected: null,
      error: result.error || result.stderr || "Unable to read Browse session status.",
      initialized: null,
      mode: null,
      pid: null,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as BrowseStatusPayload;
    const targetHeadless = parsed.target?.headless;
    return {
      browserConnected: typeof parsed.browserConnected === "boolean" ? parsed.browserConnected : null,
      error: null,
      initialized: typeof parsed.initialized === "boolean" ? parsed.initialized : null,
      mode: normalizeMode(parsed.mode) ?? (typeof targetHeadless === "boolean" ? targetHeadless ? "headless" : "headed" : null),
      pid: typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : null,
    };
  } catch (error) {
    return {
      browserConnected: null,
      error: error instanceof Error ? error.message : "Unable to parse Browse session status.",
      initialized: null,
      mode: null,
      pid: null,
    };
  }
}
