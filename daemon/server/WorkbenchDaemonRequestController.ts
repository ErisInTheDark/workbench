/*
 * Exports:
 * - WorkbenchBrowseSessionPort: replaceable Browse session request boundary.
 * - default WorkbenchDaemonRequestController: dispatch semantic browser daemon requests to their handlers (./requests), thread actions and
 *   Git arc actions, and map failures to JSON-RPC errors.
 */
import {
  WORKBENCH_GIT_ARC_ACTION_BY_METHOD,
  workbenchDaemonRequests,
  type WorkbenchDaemonGitArcMethod,
} from "workbench-shared/workbench/daemon/workbench-daemon-requests";
import {
  createGitArcOperationRejected,
  GitArcFailureException,
  parseGitArcFailureEnvelope,
} from "workbench-shared/workbench/git/git-arc-failures";
import { WorkbenchThreadHistoryPendingError, WORKBENCH_THREAD_HISTORY_PENDING } from "workbench-shared/workbench/provider/provider-thread";
import { workbenchThreadActions, WorkbenchTranscriptRecoveryRequiredError, WORKBENCH_TRANSCRIPT_RECOVERY_REQUIRED } from "workbench-shared/workbench/thread/thread-actions";
import { WorkbenchSkillActivationMismatchError } from "workbench-shared/workbench/thread/thread-skill-mentions";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import {
  InvalidParamsError,
  record,
  type DaemonHandledMethod,
  type DaemonRequestContext,
  type DaemonRequestHandlers,
  type InstallationUpdatePort,
  type ProviderRuntimePort,
  type WorkbenchBrowseSessionPort,
  type WorkbenchDaemonRequestOwners,
} from "./requests/daemon-request-handler";
import { projectRequestHandlers } from "./requests/project-handlers";
import { providerRequestHandlers } from "./requests/provider-handlers";
import { settingsRequestHandlers } from "./requests/settings-handlers";
import { statsRequestHandlers } from "./requests/stats-handlers";
import { threadRequestHandlers } from "./requests/thread-handlers";

export type { WorkbenchBrowseSessionPort } from "./requests/daemon-request-handler";

// Typed so adding a daemon method fails typecheck until it has exactly one handler here.
const HANDLERS: DaemonRequestHandlers<DaemonHandledMethod> = {
  ...projectRequestHandlers,
  ...providerRequestHandlers,
  ...settingsRequestHandlers,
  ...statsRequestHandlers,
  ...threadRequestHandlers,
};

const METHODS = new Set<string>([
  ...Object.keys(HANDLERS),
  ...Object.keys(workbenchThreadActions),
  ...Object.keys(WORKBENCH_GIT_ARC_ACTION_BY_METHOD),
]);

function isGitArcMethod(method: string): method is WorkbenchDaemonGitArcMethod {
  return method in WORKBENCH_GIT_ARC_ACTION_BY_METHOD;
}

function isHandledMethod(method: string): method is DaemonHandledMethod {
  return Object.hasOwn(HANDLERS, method);
}

export default class WorkbenchDaemonRequestController {
  private browse: WorkbenchBrowseSessionPort | null = null;
  private readonly installationUpdateRegistrations = new Set<InstallationUpdatePort>();
  private readonly providerRuntimeRegistrations = new Set<ProviderRuntimePort>();
  private readonly context: DaemonRequestContext;

  constructor(private readonly owners: WorkbenchDaemonRequestOwners) {
    this.context = {
      owners,
      browse: () => this.browse,
      installationUpdate: () => [...this.installationUpdateRegistrations].at(-1) ?? null,
      providerRuntimes: () => [...this.providerRuntimeRegistrations].at(-1) ?? null,
    };
  }

  accepts(method: string) { return METHODS.has(method); }
  registerBrowse(port: WorkbenchBrowseSessionPort) { this.browse = port; return () => { if (this.browse === port) this.browse = null; }; }
  registerInstallationUpdate(port: InstallationUpdatePort) {
    this.installationUpdateRegistrations.add(port);
    return () => { this.installationUpdateRegistrations.delete(port); };
  }
  registerProviderRuntimes(port: ProviderRuntimePort) {
    this.providerRuntimeRegistrations.add(port);
    return () => { this.providerRuntimeRegistrations.delete(port); };
  }

  async handle(request: JsonRpcRequest, connectionId?: string): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    try {
      const params = record(request.params ?? {});
      const method = request.method ?? "";
      if (method in workbenchThreadActions) {
        if (!this.owners.threadActions) throw new Error("Workbench thread actions are unavailable.");
        return { id, result: await this.owners.threadActions.handle(method as keyof typeof workbenchThreadActions, params, connectionId) };
      }
      if (isGitArcMethod(method)) return { id, result: await this.executeGitArc(method, params) };
      if (!isHandledMethod(method)) return { id, error: { code: -32601, message: "Daemon method not found." } };
      return { id, result: await HANDLERS[method](params, this.context) };
    } catch (error) {
      return {
        id,
        error: {
          code: error instanceof InvalidParamsError ? -32602
            : error instanceof WorkbenchTranscriptRecoveryRequiredError ? WORKBENCH_TRANSCRIPT_RECOVERY_REQUIRED
            : error instanceof WorkbenchThreadHistoryPendingError ? WORKBENCH_THREAD_HISTORY_PENDING : -32000,
          ...(error instanceof GitArcFailureException ? { data: { gitArcFailure: error.failure } } : {}),
          ...(error instanceof WorkbenchSkillActivationMismatchError ? { data: { skillActivationMismatch: error.mismatch } } : {}),
          message: error instanceof Error ? error.message : "Daemon request failed.",
        },
      };
    }
  }

  private async executeGitArc(method: WorkbenchDaemonGitArcMethod, params: Record<string, unknown>) {
    const action = WORKBENCH_GIT_ARC_ACTION_BY_METHOD[method];
    const response = await this.owners.gitArc.executeRequest({ action, ...params });
    const text = await response.text();
    if (!response.ok) {
      const envelope = parseGitArcFailureEnvelope(text);
      throw new GitArcFailureException(envelope?.gitArcFailure ?? createGitArcOperationRejected(
        action,
        envelope?.error || text.trim() || "Git arc request failed.",
      ));
    }
    if (method === "git/arc/diff-artifact/read") return text;
    // Mutations answer with internal receipts; browsers only learn that they succeeded.
    if (method === "git/arc/release" || method === "git/arc/remove" || method === "git/arc/restore"
      || method === "git/arc/stash/discard") {
      return { ok: true as const };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`The ${method} result was not valid JSON.`);
    }
    // Stash receipts carry internal checkpoint fields; only the browser-safe ones are published.
    const published = method === "git/arc/stash" || method === "git/arc/unstash" ? {
      conflictedPaths: (value as { conflictedPaths?: unknown }).conflictedPaths,
      phase: (value as { phase?: unknown }).phase,
      stashedPaths: (value as { stashedPaths?: unknown }).stashedPaths,
    } : value;
    const parsed = workbenchDaemonRequests[method].result.safeParse(published);
    if (!parsed.success) throw new Error(`The ${method} result did not match its contract.`);
    return parsed.data;
  }
}
