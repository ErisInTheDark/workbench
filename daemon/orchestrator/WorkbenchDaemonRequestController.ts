/*
 * Exports:
 * - WorkbenchBrowseSessionPort: replaceable Browse session request boundary. Keywords: browse, reload, port.
 * - default WorkbenchDaemonRequestController: dispatch semantic browser daemon requests to their real owners. Keywords: daemon, rpc, registry.
 */
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchAgentSkillCatalogController from "./WorkbenchAgentSkillCatalogController";
import type WorkbenchCodexSandboxNetworkController from "./WorkbenchCodexSandboxNetworkController";
import type WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import type WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import type WorkbenchNativeFileController from "./WorkbenchNativeFileController";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import type WorkbenchProjectFileController from "./WorkbenchProjectFileController";
import type WorkbenchServerSettings from "../lib/workbench/settings/WorkbenchServerSettings";
import { WorkbenchComposerProfileSelectionSchema, WorkbenchComposerProfileSlotSchema } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import {
  WorkbenchThreadIdentityResolutionSchema,
  WorkbenchThreadIdentityResolveRequestSchema,
} from "workbench-shared/workbench/thread/workbench-thread-identity";
import type WorkbenchSearchController from "./WorkbenchSearchController";
import type WorkbenchStatsController from "./stats/WorkbenchStatsController";
import { WorkbenchStatsReadRequestSchema } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { WorkbenchStatsDetailedReadRequestSchema } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import {
  GitCheckpointCompareResultSchema,
  GitCheckpointProposalSchema,
} from "workbench-shared/workbench/git/checkpoint-contracts";
import {
  createGitArcOperationRejected,
  GitArcFailureException,
  parseGitArcFailureEnvelope,
} from "workbench-shared/workbench/git/git-arc-failures";
import {
  WORKBENCH_GIT_ARC_ACTION_BY_METHOD,
  type WorkbenchDaemonGitArcMethod,
} from "workbench-shared/workbench/daemon/workbench-daemon-requests";
import type {
  OpenFileInEditorRequest,
  ResolveExternalFileLinkRootsRequest,
  RevealProjectEntryRequest,
  WorkbenchComposerProfileSlot,
} from "workbench-shared/types";

export interface WorkbenchBrowseSessionPort {
  controlSession(params: object): Promise<object>;
  listSessions(params: object): Promise<object>;
}

const METHODS = new Set([
  "agents/list", "agents/read",
  "browse/sessions/forget", "browse/sessions/read", "browse/sessions/stop",
  "codex-sandbox-network/read", "codex-sandbox-network/update",
  ...Object.keys(WORKBENCH_GIT_ARC_ACTION_BY_METHOD),
  "local-capabilities/read", "local-capabilities/update",
  "native/file/link-roots", "native/file/open", "native/file/reveal",
  "profiles/delete", "profiles/read", "profiles/target/read", "profiles/target/set", "profiles/upsert",
  "project/catalog/read",
  "project/file/read", "project/file/reset", "project/file/save",
  "search/query",
  "stats/import/start", "stats/rate-limits/refresh", "stats/read", "stats/read/detailed",
  "skills/read",
  "thread/identity/resolve",
]);

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidParamsError("A daemon request object is required.");
  return value as Record<string, unknown>;
}

class InvalidParamsError extends Error {}

function isGitArcMethod(method: string): method is WorkbenchDaemonGitArcMethod {
  return method in WORKBENCH_GIT_ARC_ACTION_BY_METHOD;
}

function requiredString(params: Record<string, unknown>, name: string) {
  const value = typeof params[name] === "string" ? params[name].trim() : "";
  if (!value) throw new InvalidParamsError(`${name} is required.`);
  return value;
}

function requiredText(params: Record<string, unknown>, name: string) {
  const value = params[name];
  if (typeof value !== "string") throw new InvalidParamsError(`${name} must be a string.`);
  return value;
}

function optionalFiniteNumber(params: Record<string, unknown>, name: string) {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InvalidParamsError(`${name} must be a finite number.`);
  return value;
}

function requiredFiniteNumber(params: Record<string, unknown>, name: string) {
  const value = optionalFiniteNumber(params, name);
  if (value === null) throw new InvalidParamsError(`${name} is required.`);
  return value;
}

function openFileRequest(params: Record<string, unknown>): OpenFileInEditorRequest {
  const absolutePath = params.absolutePath === null || params.absolutePath === undefined
    ? null
    : requiredString(params, "absolutePath");
  const projectId = params.projectId === null || params.projectId === undefined
    ? null
    : requiredString(params, "projectId");
  const path = typeof params.path === "string" ? params.path : "";
  if (!absolutePath && (!projectId || !path.trim())) {
    throw new InvalidParamsError("A project file or absolute path is required.");
  }
  return {
    absolutePath,
    columnNumber: optionalFiniteNumber(params, "columnNumber"),
    lineNumber: optionalFiniteNumber(params, "lineNumber"),
    path,
    projectId,
  };
}

function linkRootsRequest(params: Record<string, unknown>): ResolveExternalFileLinkRootsRequest {
  if (!Array.isArray(params.paths) || params.paths.some((value) => typeof value !== "string")) {
    throw new InvalidParamsError("paths must be an array of strings.");
  }
  return { paths: params.paths };
}

export default class WorkbenchDaemonRequestController {
  private browse: WorkbenchBrowseSessionPort | null = null;

  constructor(private readonly owners: {
    agents: Pick<WorkbenchAgentSkillCatalogController, "listAgents" | "readAgent" | "readSkills">;
    codexSandboxNetwork: Pick<WorkbenchCodexSandboxNetworkController, "read" | "setGlobal" | "setProjectOverride">;
    files: Pick<WorkbenchProjectFileController, "read" | "write">;
    gitArc: Pick<WorkbenchGitArcFeature, "executeRequest">;
    nativeFiles: Pick<WorkbenchNativeFileController, "linkRoots" | "open" | "reveal">;
    profiles: Pick<WorkbenchComposerProfileStore, "mutate" | "read">;
    profileTargets: Pick<WorkbenchThreadStateController, "readComposerProfileTarget" | "setComposerProfileTarget">;
    projects: Pick<WorkbenchProjectCatalogController, "readCatalog" | "resolveProjectById">;
    search: Pick<WorkbenchSearchController, "search">;
    stats: Pick<WorkbenchStatsController, "read" | "readDetailed" | "refreshRateLimits" | "startImport">;
    settings: Pick<WorkbenchServerSettings, "readLocalCapabilities" | "updateLocalCapabilities">;
    threadIdentity: Pick<WorkbenchThreadIdentityController, "resolve">;
  }) {}

  accepts(method: string) { return METHODS.has(method); }
  registerBrowse(port: WorkbenchBrowseSessionPort) { this.browse = port; return () => { if (this.browse === port) this.browse = null; }; }

  private async nativeProfileSlot(slot: WorkbenchComposerProfileSlot): Promise<WorkbenchComposerProfileSlot> {
    if (slot.kind !== "thread") return slot;
    const thread = await this.owners.threadIdentity.resolve({ threadId: slot.threadId, projectId: slot.projectId, harness: slot.harness });
    const binding = thread?.bindings[0];
    if (!binding) throw new InvalidParamsError("Composer thread has no native profile destination.");
    return WorkbenchComposerProfileSlotSchema.parse({ ...slot, threadId: binding.nativeThreadId, harness: binding.harness });
  }

  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    try {
      const params = record(request.params ?? {});
      if (isGitArcMethod(request.method ?? "")) {
        return { id, result: await this.executeGitArc(request.method as WorkbenchDaemonGitArcMethod, params) };
      }
      let result: object;
      switch (request.method) {
        case "thread/identity/resolve": {
          const parsed = WorkbenchThreadIdentityResolveRequestSchema.safeParse(params);
          if (!parsed.success) throw new InvalidParamsError("Invalid thread identity lookup.");
          const identity = await this.owners.threadIdentity.resolve(parsed.data);
          result = { data: identity ? WorkbenchThreadIdentityResolutionSchema.parse({
            threadId: identity.threadId,
            projectId: identity.projectId,
            harness: identity.bindings[0]?.harness,
          }) : null };
          break;
        }
        case "codex-sandbox-network/read": {
          const projectId = requiredString(params, "projectId");
          await this.owners.projects.resolveProjectById(projectId);
          result = { codexSandboxNetwork: await this.owners.codexSandboxNetwork.read(projectId) };
          break;
        }
        case "codex-sandbox-network/update": {
          const projectId = requiredString(params, "projectId");
          await this.owners.projects.resolveProjectById(projectId);
          if (params.scope === "global") {
            if (typeof params.enabled !== "boolean") {
              throw new InvalidParamsError("A global Codex sandbox network update requires a boolean enabled value.");
            }
            const enabled = params.enabled as boolean;
            await this.owners.codexSandboxNetwork.setGlobal(enabled);
          } else if (params.scope === "project") {
            if (typeof params.enabled !== "boolean" && params.enabled !== null) {
              throw new InvalidParamsError("A project Codex sandbox network update requires a boolean or null enabled value.");
            }
            const enabled = params.enabled === null ? null : params.enabled as boolean;
            await this.owners.codexSandboxNetwork.setProjectOverride(projectId, enabled);
          } else {
            throw new InvalidParamsError("scope must be global or project.");
          }
          result = { codexSandboxNetwork: await this.owners.codexSandboxNetwork.read(projectId) };
          break;
        }
        case "project/catalog/read": result = await this.owners.projects.readCatalog(); break;
        case "project/file/read": result = await this.owners.files.read({
          path: requiredString(params, "path"),
          projectId: requiredString(params, "projectId"),
        }); break;
        case "project/file/save": result = await this.owners.files.write({
          content: requiredText(params, "content"),
          expectedMtimeMs: requiredFiniteNumber(params, "expectedMtimeMs"),
          force: params.force === true,
          path: requiredString(params, "path"),
          projectId: requiredString(params, "projectId"),
          resetToHead: false,
        }); break;
        case "project/file/reset": result = await this.owners.files.write({
          expectedMtimeMs: requiredFiniteNumber(params, "expectedMtimeMs"),
          force: params.force === true,
          path: requiredString(params, "path"),
          projectId: requiredString(params, "projectId"),
          resetToHead: true,
        }); break;
        case "search/query": {
          const projectId = params.projectId === null || params.projectId === ""
            ? null
            : requiredString(params, "projectId");
          if (projectId) {
            try {
              await this.owners.projects.resolveProjectById(projectId);
            } catch (error) {
              throw new InvalidParamsError(error instanceof Error ? error.message : "Unknown project.");
            }
          }
          result = await this.owners.search.search({
            projectId,
            query: requiredText(params, "query"),
          });
          break;
        }
        case "stats/read":
        case "stats/read/detailed": {
          const parsed = (request.method === "stats/read/detailed" ? WorkbenchStatsDetailedReadRequestSchema : WorkbenchStatsReadRequestSchema).safeParse(params);
          if (!parsed.success) throw new InvalidParamsError("Invalid stats request.");
          if (parsed.data.projectId) {
            try {
              await this.owners.projects.resolveProjectById(parsed.data.projectId);
            } catch (error) {
              throw new InvalidParamsError(error instanceof Error ? error.message : "Unknown project.");
            }
          }
          result = request.method === "stats/read/detailed"
            ? await this.owners.stats.readDetailed(parsed.data)
            : await this.owners.stats.read(parsed.data);
          break;
        }
        case "stats/import/start":
          if (Object.keys(params).length) throw new InvalidParamsError("Stats import start does not accept parameters.");
          result = await this.owners.stats.startImport();
          break;
        case "stats/rate-limits/refresh":
          await this.owners.stats.refreshRateLimits();
          result = { ok: true };
          break;
        case "local-capabilities/read": result = { localCapabilities: await this.owners.settings.readLocalCapabilities() }; break;
        case "local-capabilities/update": {
          const local = record(params.localCapabilities);
          result = { localCapabilities: await this.owners.settings.updateLocalCapabilities((current) => ({
            ...current,
            ...(typeof local.browseRawCommandsEnabled === "boolean" ? { browseRawCommandsEnabled: local.browseRawCommandsEnabled } : {}),
          })) };
          break;
        }
        case "agents/list": result = await this.owners.agents.listAgents(requiredString(params, "projectId")); break;
        case "agents/read": result = await this.owners.agents.readAgent(requiredString(params, "projectId"), requiredString(params, "agentPath")); break;
        case "skills/read": result = await this.owners.agents.readSkills(typeof params.projectId === "string" ? params.projectId : null); break;
        case "native/file/open": result = await this.owners.nativeFiles.open(openFileRequest(params)); break;
        case "native/file/reveal": result = await this.owners.nativeFiles.reveal({
          path: requiredString(params, "path"),
          projectId: requiredString(params, "projectId"),
        } satisfies RevealProjectEntryRequest); break;
        case "native/file/link-roots": result = await this.owners.nativeFiles.linkRoots(linkRootsRequest(params)); break;
        case "profiles/read": result = await this.owners.profiles.read(); break;
        case "profiles/target/read": {
          const slot = WorkbenchComposerProfileSlotSchema.safeParse(params.slot);
          if (!slot.success) throw new InvalidParamsError("slot must identify a composer profile target.");
          result = { selection: await this.owners.profileTargets.readComposerProfileTarget(await this.nativeProfileSlot(slot.data)) };
          break;
        }
        case "profiles/target/set": {
          const slot = WorkbenchComposerProfileSlotSchema.safeParse(params.slot);
          const selection = WorkbenchComposerProfileSelectionSchema.safeParse(params.selection);
          if (!slot.success) throw new InvalidParamsError("slot must identify a composer profile target.");
          if (!selection.success) throw new InvalidParamsError("selection must contain exact composer settings.");
          const ok = await this.owners.profileTargets.setComposerProfileTarget(
            await this.nativeProfileSlot(slot.data),
            selection.data,
          );
          if (!ok) throw new InvalidParamsError("The composer profile target does not exist or rejects these settings.");
          result = { ok: true };
          break;
        }
        case "profiles/delete": result = await this.owners.profiles.mutate({
          kind: "delete",
          profileId: requiredString(params, "profileId"),
        }); break;
        case "profiles/upsert": result = await this.owners.profiles.mutate({
          kind: "upsert",
          profile: record(params.profile),
          ...(params.changes !== undefined ? { changes: record(params.changes) } : {}),
        }); break;
        case "browse/sessions/read":
          if (!this.browse) throw new Error("Browse session management is reloading.");
          result = await this.browse.listSessions(params);
          break;
        case "browse/sessions/forget":
        case "browse/sessions/stop":
          if (!this.browse) throw new Error("Browse session management is reloading.");
          result = await this.browse.controlSession({
            ...params,
            action: request.method.endsWith("/forget") ? "forget" : "stop",
          });
          break;
        default: return { id, error: { code: -32601, message: "Daemon method not found." } };
      }
      return { id, result };
    } catch (error) {
      return {
        id,
        error: {
          code: error instanceof InvalidParamsError ? -32602 : -32000,
          ...(error instanceof GitArcFailureException ? { data: { gitArcFailure: error.failure } } : {}),
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
    if (method === "git/arc/release" || method === "git/arc/remove" || method === "git/arc/restore") {
      return { ok: true as const };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`The ${method} result was not valid JSON.`);
    }
    const parsed = method === "git/arc/compare"
      ? GitCheckpointCompareResultSchema.safeParse(value)
      : GitCheckpointProposalSchema.safeParse(value);
    if (!parsed.success) throw new Error(`The ${method} result did not match its contract.`);
    return parsed.data;
  }
}
