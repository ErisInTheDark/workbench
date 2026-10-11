/*
 * Exports:
 * - WorkbenchBrowseExecutionContext: cwd-derived Browse project ownership.
 * - WorkbenchBrowseDaemonTransport: injectable warm daemon transport contract.
 * - WorkbenchBrowseProjectResolver: injected daemon project-catalog resolution port.
 * - WorkbenchBrowseProjectIdResolver: injected project-ID catalog resolution port.
 * - WorkbenchBrowseRuntimeProfileStore: injectable persistent-profile resolver contract.
 * - WorkbenchBrowseCallerWaiter: separate caller-visible deadlines from underlying daemon completion.
 * - prepareWorkbenchBrowseDaemonProcess: lower and detach a Browse child in lifecycle order.
 * - default WorkbenchBrowseRuntime: own warm Browse imports, per-session FIFO, daemon bootstrap, observation, and retirement.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { appRoot, normalizeRelativePath, type ResolvedProject } from "../../project";
import type { WorkbenchBrowseCommandRequest, WorkbenchBrowseCommandResponse } from "workbench-shared/types";
import { killProcessTreeAsync, logError, lowerAgentProcessPriority } from "../../../process-helpers";
import {
  type AgentEndpointProjectResolution,
} from "../project/agent-endpoint-project";
import type { WorkbenchBrowseAgentCommand } from "./actions/browse-action-registry";
import type { BrowseJsonValue, BrowseRuntimeRequest } from "./actions/session-actions";
import WorkbenchBrowseDaemonClient, {
  WorkbenchBrowseDaemonTimeoutError,
  type WorkbenchBrowseDaemonRequestWithoutId,
} from "./WorkbenchBrowseDaemonClient";

export interface WorkbenchBrowseExecutionContext {
  cwd: string;
  owningRootPath: string;
  projectId: string | null;
  projectRootPath: string | null;
  workspaceRoots: Array<{ id: string; name: string; rootPath: string }>;
  workspaceRootPaths: string[];
}

export type WorkbenchBrowseProjectResolver = (
  cwd: string | null | undefined,
  options?: { endpointName?: string },
) => Promise<AgentEndpointProjectResolution>;

export type WorkbenchBrowseProjectIdResolver = (
  projectId?: string | null,
) => Promise<ResolvedProject>;

export interface WorkbenchBrowseDaemonTransport {
  cleanupRuntimeFiles(session: string): Promise<void>;
  getRuntimeDirectoryPath(): string;
  initialize(): Promise<void>;
  listRuntimeSessionNames(): Promise<string[]>;
  readPid(session: string): Promise<number | null>;
  request(
    session: string,
    request: WorkbenchBrowseDaemonRequestWithoutId,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BrowseJsonValue>;
}

export interface WorkbenchBrowseRuntimeProfileStore {
  resolveProfilePath(options: { persistent: boolean; sessionName: string }): Promise<string | null>;
}

type WorkbenchBrowseProcessRetirer = (pid: number) => Promise<void>;
export type WorkbenchBrowseCallerWaiter = <TValue>(
  completion: Promise<TValue>,
  options: { deadline: number; message: string; signal?: AbortSignal },
) => Promise<TValue>;

class BrowseRetirementError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Browse retirement failed.", { cause });
  }
}

const IDLE_GATE = Promise.resolve();
const DAEMON_START_POLL_MS = 100;

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function stdout(value: object) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function remainingTimeout(deadline: number, session: string) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new WorkbenchBrowseDaemonTimeoutError(`Browse session ${session} timed out.`);
  return Math.max(1, remaining);
}

const waitForCaller: WorkbenchBrowseCallerWaiter = async (completion, { deadline, message, signal }) => {
  const timeoutMs = Math.max(1, deadline - Date.now());
  if (signal?.aborted) throw signal.reason;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      operation();
    };
    const abort = () => finish(() => reject(signal?.reason ?? new Error("Browse request cancelled.")));
    const timer = setTimeout(() => finish(() => reject(
      new WorkbenchBrowseDaemonTimeoutError(message),
    )), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    void completion.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
};

function isObservationRequest(request: BrowseRuntimeRequest) {
  return request.kind === "status"
    || (request.kind === "command" && request.command === "screenshot");
}

export function prepareWorkbenchBrowseDaemonProcess(
  child: Pick<ReturnType<typeof spawn>, "pid" | "unref">,
  lowerPriority: typeof lowerAgentProcessPriority = lowerAgentProcessPriority,
) {
  lowerPriority(child);
  child.unref();
}

export default class WorkbenchBrowseRuntime {
  private readonly client: WorkbenchBrowseDaemonTransport;
  private readonly profileStore: WorkbenchBrowseRuntimeProfileStore | undefined;
  private readonly retireProcess: WorkbenchBrowseProcessRetirer;
  private readonly resolveProjectById: WorkbenchBrowseProjectIdResolver;
  private readonly resolveProjectFromCwd: WorkbenchBrowseProjectResolver;
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly waitForCaller: WorkbenchBrowseCallerWaiter;

  constructor({
    client = new WorkbenchBrowseDaemonClient(),
    profileStore,
    retireProcess = killProcessTreeAsync,
    resolveProjectById,
    resolveProjectFromCwd,
    waitForCaller: callerWaiter = waitForCaller,
  }: {
    client?: WorkbenchBrowseDaemonTransport;
    profileStore?: WorkbenchBrowseRuntimeProfileStore;
    retireProcess?: WorkbenchBrowseProcessRetirer;
    resolveProjectById: WorkbenchBrowseProjectIdResolver;
    resolveProjectFromCwd: WorkbenchBrowseProjectResolver;
    waitForCaller?: WorkbenchBrowseCallerWaiter;
  }) {
    this.client = client;
    this.profileStore = profileStore;
    this.retireProcess = retireProcess;
    this.resolveProjectById = resolveProjectById;
    this.resolveProjectFromCwd = resolveProjectFromCwd;
    this.waitForCaller = callerWaiter;
  }

  async initialize() {
    await this.client.initialize();
  }

  async resolveExecutionContext(request: Pick<WorkbenchBrowseCommandRequest, "cwd" | "projectId">): Promise<WorkbenchBrowseExecutionContext> {
    if (request.cwd) {
      const resolution = await this.resolveProjectFromCwd(request.cwd, { endpointName: "Browse" });
      return {
        cwd: resolution.cwd,
        owningRootPath: resolution.root.root,
        projectId: resolution.project.id,
        projectRootPath: normalizeRelativePath(resolution.project.root),
        workspaceRoots: resolution.project.roots.map((root) => ({ id: root.id, name: root.name, rootPath: root.root })),
        workspaceRootPaths: resolution.project.roots.map((root) => root.root),
      };
    }
    const project = await this.resolveProjectById(request.projectId);
    return {
      cwd: path.resolve(project.root),
      owningRootPath: project.root,
      projectId: project.id,
      projectRootPath: normalizeRelativePath(project.root),
      workspaceRoots: project.roots.map((root) => ({ id: root.id, name: root.name, rootPath: root.root })),
      workspaceRootPaths: project.roots.map((root) => root.root),
    };
  }

  async listRuntimeSessionNames() {
    return await this.client.listRuntimeSessionNames();
  }

  async readRuntimePid(session: string) {
    return await this.client.readPid(session);
  }

  async run(command: WorkbenchBrowseAgentCommand, execution: WorkbenchBrowseExecutionContext, signal?: AbortSignal): Promise<WorkbenchBrowseCommandResponse> {
    const startedAt = Date.now();
    const deadline = startedAt + command.runtimeRequest.timeoutMs;
    try {
      const execute = async () => await this.execute(command.runtimeRequest, execution, deadline);
      const forceStop = command.runtimeRequest.kind === "stop" && command.runtimeRequest.force;
      const result = forceStop
        ? await execute()
        : command.runtimeRequest.session && !isObservationRequest(command.runtimeRequest)
        ? await this.enqueueSession(command.runtimeRequest.session, execute, deadline, signal)
        : await this.waitForCaller(execute(), {
          deadline,
          message: `Browse session ${command.runtimeRequest.session ?? "request"} timed out.`,
          ...(signal ? { signal } : {}),
        });
      return {
        durationMs: Date.now() - startedAt,
        exitCode: 0,
        ok: true,
        stderr: "",
        stdout: stdout(result as object),
      };
    } catch (error) {
      return {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Browse runtime failed.",
        exitCode: 1,
        ok: false,
        stderr: "",
        stdout: "",
        timedOut: error instanceof WorkbenchBrowseDaemonTimeoutError || undefined,
      };
    }
  }

  async status(session: string, timeoutMs = 5_000, signal?: AbortSignal) {
    const deadline = Date.now() + timeoutMs;
    return await this.waitForCaller(this.readStatus(session, timeoutMs), {
      deadline,
      message: `Browse session ${session} status timed out.`,
      ...(signal ? { signal } : {}),
    });
  }

  async inspectStatus(session: string, timeoutMs = 5_000, signal?: AbortSignal) {
    return await this.status(session, timeoutMs, signal);
  }

  async stop(session: string, { force = false, signal, timeoutMs = 5_000 }: { force?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}) {
    const deadline = Date.now() + timeoutMs;
    if (force) {
      const pid = await this.client.readPid(session);
      await this.retireSession(session, pid);
      return { stopped: Boolean(pid) };
    }
    return await this.enqueueSession(session, async () => await this.stopNow(session, { deadline, force: false }), deadline, signal);
  }

  private async execute(request: BrowseRuntimeRequest, execution: WorkbenchBrowseExecutionContext, deadline: number) {
    switch (request.kind) {
      case "doctor": {
        const status = request.session ? await this.readStatus(request.session, remainingTimeout(deadline, request.session)) : null;
        return {
          checks: [
            { message: "Workbench warm Browse runtime imported", name: "runtime", status: "ok" },
            { message: request.session ?? "no session selected", name: "session", status: "ok" },
            { message: status ? "active daemon" : "no active daemon", name: "daemon", status: "ok" },
          ],
          session: request.session,
          status,
          verdict: "ok",
        };
      }
      case "status":
        return await this.readStatus(request.session, remainingTimeout(deadline, request.session)) ?? {
          browserConnected: false,
          initialized: false,
          session: request.session,
        };
      case "stop":
        if (request.force) {
          const pid = await this.client.readPid(request.session);
          await this.retireSession(request.session, pid);
          return { stopped: Boolean(pid) };
        }
        return await this.stopNow(request.session, { deadline, force: request.force });
      case "open": {
        await this.ensureDaemon(request, execution, deadline);
        const timeoutMs = remainingTimeout(deadline, request.session);
        return await this.client.request(request.session, {
          timeoutMs,
          type: "open",
          url: request.params.url,
          waitUntil: request.params.waitUntil,
        }, timeoutMs);
      }
      case "command": {
        // A busy page can delay the daemon's status response; give it the command's own deadline so a slow but live session is not retired.
        const status = await this.readStatus(request.session, remainingTimeout(deadline, request.session));
        if (!status) throw new Error(`Browse session ${request.session} is not running. Open it before sending browser commands.`);
        const timeoutMs = remainingTimeout(deadline, request.session);
        return await this.client.request(request.session, {
          command: request.command,
          params: request.params,
          type: "command",
        }, timeoutMs);
      }
    }
  }

  private async ensureDaemon(request: Extract<BrowseRuntimeRequest, { kind: "open" }>, execution: WorkbenchBrowseExecutionContext, deadline: number, signal?: AbortSignal) {
    const existing = await this.readStatus(request.session, Math.min(remainingTimeout(deadline, request.session), 1_000), signal);
    if (existing) return;
    const pid = await this.client.readPid(request.session);
    if (pid) await this.retireSession(request.session, pid);
    if (signal?.aborted) throw signal.reason;
    const daemonEntrypoint = path.join(appRoot, "server", "lib", "workbench", "browse", "run-browse-daemon.mjs");
    await fs.access(daemonEntrypoint);
    if (!this.profileStore) throw new Error("Browse launch requires a persistent-profile catalogue.");
    const profilePath = await this.profileStore.resolveProfilePath({ persistent: request.persistent, sessionName: request.session });
    const target = { headless: request.mode === "headless", kind: "managed-local" };
    const child = spawn(process.execPath, [daemonEntrypoint, "--session", request.session, "--target", JSON.stringify(target)], {
      cwd: execution.cwd,
      detached: true,
      env: {
        ...process.env,
        BROWSERBASE_TELEMETRY_DISABLED: "1",
        BROWSE_DAEMON_DIR: this.client.getRuntimeDirectoryPath(),
        BROWSE_DISABLE_UPDATE_CHECK: "1",
        WORKBENCH_BROWSE_DOWNLOADS_PATH: execution.cwd,
        ...(profilePath ? { WORKBENCH_BROWSE_USER_DATA_DIR: profilePath } : {}),
      },
      shell: false,
      stdio: "ignore",
      windowsHide: request.mode === "headless",
    });
    prepareWorkbenchBrowseDaemonProcess(child);
    // The command's own deadline owns how long a cold daemon may take; a fixed cap killed valid slow starts.
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason;
      const status = await this.readStatus(request.session, Math.min(remainingTimeout(deadline, request.session), 1_000), signal);
      if (status) return;
      await delay(DAEMON_START_POLL_MS);
    }
    throw new WorkbenchBrowseDaemonTimeoutError(`Browse session ${request.session} daemon did not start before its deadline.`);
  }

  private async readStatus(session: string, timeoutMs: number, signal?: AbortSignal) {
    if (!await this.client.readPid(session)) return null;
    try {
      return await this.client.request(session, { type: "status" }, timeoutMs, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EPIPE") return null;
      throw error;
    }
  }

  private async retireSession(session: string, knownPid?: number | null) {
    try {
      const pid = knownPid === undefined ? await this.client.readPid(session) : knownPid;
      if (pid) await this.retireProcess(pid);
      await this.client.cleanupRuntimeFiles(session);
    } catch (error) {
      logError("browse-retirement", "session retirement or runtime-record cleanup failed");
      throw new BrowseRetirementError(error);
    }
  }

  private async stopNow(session: string, { deadline, force, signal }: { deadline: number; force: boolean; signal?: AbortSignal }) {
    const pid = await this.client.readPid(session);
    let result: BrowseJsonValue;
    try {
      const existing = await this.readStatus(session, remainingTimeout(deadline, session), signal);
      if (!existing) {
        if (!force) return { stopped: false };
        result = { stopped: false };
      } else {
        result = await this.client.request(session, { type: "stop" }, remainingTimeout(deadline, session), signal);
      }
    } catch (error) {
      if (!force) throw error;
      result = { stopped: true };
    }
    await this.retireSession(session, pid);
    return result;
  }

  private async enqueueSession<TValue>(
    session: string,
    task: () => Promise<TValue>,
    deadline: number,
    signal?: AbortSignal,
  ) {
    const previous = this.sessionTails.get(session) ?? IDLE_GATE;
    let release = () => undefined;
    const ownCompletion = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(async () => await ownCompletion);
    this.sessionTails.set(session, current);
    let entered = false;
    try {
      await this.waitForCaller(previous, {
        deadline,
        message: `Browse session ${session} timed out while waiting for its previous command.`,
        ...(signal ? { signal } : {}),
      });
      entered = true;
      const completion = task();
      void completion.then(release, release);
      return await this.waitForCaller(completion, {
        deadline,
        message: `Browse session ${session} timed out.`,
        ...(signal ? { signal } : {}),
      });
    } finally {
      if (!entered) release();
      void current.then(() => {
        if (this.sessionTails.get(session) === current) this.sessionTails.delete(session);
      });
    }
  }
}
