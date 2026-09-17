/*
 * Exports:
 * - WorkbenchBrowseSessionPort: replaceable Browse session request boundary.
 * - default WorkbenchDaemonRequestController: dispatch semantic browser daemon requests to their real owners.
 */
import type {
    OpenFileInEditorRequest,
    ResolveExternalFileLinkRootsRequest,
    RevealProjectEntryRequest,
    WorkbenchUserInputResponse,
    WorkbenchComposerProfileSlot,
    WorkbenchComposerSettings,
} from "workbench-shared/types";
import {
    WORKBENCH_GIT_ARC_ACTION_BY_METHOD,
    type WorkbenchDaemonGitArcMethod,
    type WorkbenchQuestionnaireRespondRequest,
} from "workbench-shared/workbench/daemon/workbench-daemon-requests";
import { WorkbenchUserInputSchema } from "workbench-shared/workbench/provider/provider-input";
import {
    GitCheckpointCompareResultSchema,
    GitCheckpointProposalSchema,
} from "workbench-shared/workbench/git/checkpoint-contracts";
import {
    createGitArcOperationRejected,
    GitArcFailureException,
    parseGitArcFailureEnvelope,
} from "workbench-shared/workbench/git/git-arc-failures";
import { WorkbenchStatsReadRequestSchema } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { cacheStatsResponse, detailedStatsResponse, WorkbenchStatsDetailedReadRequestSchema } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import { WorkbenchComposerProfileSelectionSchema, WorkbenchComposerProfileSlotInputSchema } from "workbench-shared/workbench/thread/thread-state";
import {
    WorkbenchThreadIdentityResolutionSchema,
    WorkbenchThreadIdentityResolveRequestSchema,
} from "workbench-shared/workbench/thread/workbench-thread-identity";
import type WorkbenchServerSettings from "./lib/workbench/settings/WorkbenchServerSettings";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchStatsController from "./stats/WorkbenchStatsController";
import type WorkbenchAgentSkillCatalogController from "./WorkbenchAgentSkillCatalogController";
import { WorkbenchSandboxNetworkUpdateSchema } from "workbench-shared/workbench/provider/provider-settings";
import type WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import type WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import type WorkbenchWorkingTreeController from "./WorkbenchWorkingTreeController";
import { WorkingTreeReadRequestSchema, WorkingTreeFileRequestSchema, WorkingTreeMutationSchema } from "workbench-shared/workbench/git/working-tree-contracts";
import type WorkbenchNativeFileController from "./WorkbenchNativeFileController";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import type WorkbenchProjectFileController from "./WorkbenchProjectFileController";
import type WorkbenchSearchController from "./WorkbenchSearchController";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type WorkbenchQuestionnaireResponseController from "./WorkbenchQuestionnaireResponseController";
import type WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import type WorkbenchThreadActionController from "./WorkbenchThreadActionController";
import { workbenchThreadActions } from "workbench-shared/workbench/thread/thread-actions";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { WorkbenchThreadHistoryPendingError, WORKBENCH_THREAD_HISTORY_PENDING } from "workbench-shared/workbench/provider/provider-thread";

export interface WorkbenchBrowseSessionPort {
  controlSession(params: object): Promise<object>;
  listSessions(params: object): Promise<object>;
}

const METHODS = new Set([
  "git/working-tree/read", "git/working-tree/diff", "git/working-tree/preview", "git/working-tree/mutate",
  ...Object.keys(workbenchThreadActions),
  "models/context/read",
  "models/list", "account/limits/read",
  "agents/list", "agents/read",
  "browse/sessions/forget", "browse/sessions/read", "browse/sessions/stop",
  "sandbox-network/read", "sandbox-network/update",
  ...Object.keys(WORKBENCH_GIT_ARC_ACTION_BY_METHOD),
  "local-capabilities/read", "local-capabilities/update",
  "native/file/link-roots", "native/file/open", "native/file/reveal",
  "profiles/delete", "profiles/read", "profiles/target/read", "profiles/target/set", "profiles/upsert",
  "project/catalog/read",
  "project/file/read", "project/file/reset", "project/file/save",
  "questionnaire/respond",
  "search/query",
  "stats/import/start", "stats/rate-limits/refresh", "stats/read", "stats/read/detailed", "stats/read/efficiency", "stats/read/efficiency/v2",
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

function optionalStringArray(params: Record<string, unknown>, name: string) {
  const value = params[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
    throw new InvalidParamsError(`${name} must be an array of strings.`);
  }
  return value;
}

function optionalUserInput(params: Record<string, unknown>, name: string) {
  const value = params[name];
  if (value === undefined) return undefined;
  const parsed = WorkbenchUserInputSchema.array().safeParse(value);
  if (!parsed.success) throw new InvalidParamsError(`${name} must contain valid user input.`);
  return parsed.data;
}

function questionnaireResponse(value: unknown): WorkbenchUserInputResponse {
  const response = record(value);
  const answers = record(response.answers);
  const normalized: WorkbenchUserInputResponse["answers"] = {};
  for (const [questionId, answerValue] of Object.entries(answers)) {
    if (answerValue === undefined) continue;
    const answer = record(answerValue);
    if (!Array.isArray(answer.answers) || answer.answers.some(entry => typeof entry !== "string")) {
      throw new InvalidParamsError("Questionnaire answers must be arrays of strings.");
    }
    normalized[questionId] = { answers: answer.answers };
  }
  return { answers: normalized };
}

function questionnaireRespondRequest(params: Record<string, unknown>): WorkbenchQuestionnaireRespondRequest {
  const insertAfterItemIndex = optionalFiniteNumber(params, "insertAfterItemIndex");
  if (insertAfterItemIndex !== null && (!Number.isInteger(insertAfterItemIndex) || insertAfterItemIndex < 0)) {
    throw new InvalidParamsError("insertAfterItemIndex must be a non-negative integer.");
  }
  return {
    activatedSkillPaths: optionalStringArray(params, "activatedSkillPaths"),
    insertAfterItemId: params.insertAfterItemId == null ? null : requiredString(params, "insertAfterItemId"),
    insertAfterItemIndex,
    projectId: requiredString(params, "projectId"),
    requestKey: requiredString(params, "requestKey"),
    response: questionnaireResponse(params.response),
    supplementalInput: optionalUserInput(params, "supplementalInput"),
    threadId: requiredString(params, "threadId"),
    turnId: params.turnId == null ? null : requiredString(params, "turnId"),
  };
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
    providers?: Pick<WorkbenchProviderDispatcher, "get">;
    threadActions?: Pick<WorkbenchThreadActionController, "handle">;
    agents: Pick<WorkbenchAgentSkillCatalogController, "listAgents" | "readAgent" | "readSkills">;
    files: Pick<WorkbenchProjectFileController, "read" | "write">;
    gitArc: Pick<WorkbenchGitArcFeature, "executeRequest">;
    workingTree?: Pick<WorkbenchWorkingTreeController, "read" | "diff" | "preview" | "mutate">;
    nativeFiles: Pick<WorkbenchNativeFileController, "linkRoots" | "open" | "reveal">;
    profiles: Pick<WorkbenchComposerProfileStore, "mutate" | "read">;
    profileTargets: Pick<WorkbenchThreadStateController, "readComposerProfileTarget" | "setComposerProfileTarget">;
    projects: Pick<WorkbenchProjectCatalogController, "readCatalog" | "resolveProjectById">;
    search: Pick<WorkbenchSearchController, "search">;
    stats: Pick<WorkbenchStatsController, "read" | "readDetailed" | "refreshRateLimits" | "startImport">;
    settings: Pick<WorkbenchServerSettings, "readLocalCapabilities" | "updateLocalCapabilities">;
    threadIdentity: { resolve: WorkbenchHarnessController["resolveThreadIdentity"] };
    questionnaireResponses: Pick<WorkbenchQuestionnaireResponseController, "respond">;
  }) {}

  accepts(method: string) { return METHODS.has(method); }
  registerBrowse(port: WorkbenchBrowseSessionPort) { this.browse = port; return () => { if (this.browse === port) this.browse = null; }; }

  private async resolveProfileSlot(slot: ReturnType<typeof WorkbenchComposerProfileSlotInputSchema.parse>): Promise<WorkbenchComposerProfileSlot> {
    if (slot.kind !== "thread") return slot;
    const thread = await this.owners.threadIdentity.resolve({ threadId: slot.threadId, projectId: slot.projectId, harness: slot.harness });
    if (!thread) throw new InvalidParamsError("Composer thread identity is unavailable.");
    return { ...slot, projectId: thread.projectId, threadId: thread.threadId };
  }

  async handle(request: JsonRpcRequest, connectionId?: string): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    try {
      const params = record(request.params ?? {});
      if (request.method in workbenchThreadActions) {
        if (!this.owners.threadActions) throw new Error("Workbench thread actions are unavailable.");
        return { id, result: await this.owners.threadActions.handle(request.method as keyof typeof workbenchThreadActions, params, connectionId) };
      }
      if (isGitArcMethod(request.method ?? "")) {
        return { id, result: await this.executeGitArc(request.method as WorkbenchDaemonGitArcMethod, params) };
      }
      let result: object;
      switch (request.method) {
        case "git/working-tree/read": {
          if (!this.owners.workingTree) throw new Error("Working tree is unavailable.");
          const input = WorkingTreeReadRequestSchema.parse(params);
          result = await this.owners.workingTree.read(input.projectId, input.preferCached);
          break;
        }
        case "git/working-tree/diff":
        case "git/working-tree/preview": {
          if (!this.owners.workingTree) throw new Error("Working tree is unavailable.");
          const input = WorkingTreeFileRequestSchema.parse(params);
          result = request.method.endsWith("/diff") ? await this.owners.workingTree.diff(input) : await this.owners.workingTree.preview(input);
          break;
        }
        case "git/working-tree/mutate": {
          if (!this.owners.workingTree) throw new Error("Working tree is unavailable.");
          result = await this.owners.workingTree.mutate(WorkingTreeMutationSchema.parse(params));
          break;
        }
        case "models/list":
        case "models/context/read":
        case "account/limits/read": {
          const key = installedProviderKeys.find(candidate => candidate === params.provider);
          if (!key || !this.owners.providers) throw new InvalidParamsError("The requested provider is unavailable.");
          const provider = this.owners.providers.get(key);
          if (request.method === "models/list") {
            result = { data: await provider.configuration.models.read() };
          } else if (request.method === "models/context/read") {
            result = { data: await provider.configuration.modelContext.read() };
          } else {
            if (!provider.account) throw new InvalidParamsError("The provider does not report account limits.");
            result = await provider.account.limits.read();
          }
          break;
        }
        case "thread/identity/resolve": {
          const parsed = WorkbenchThreadIdentityResolveRequestSchema.safeParse(params);
          if (!parsed.success) throw new InvalidParamsError("Invalid thread identity lookup.");
          const { allowProviderAdmission, ...lookup } = parsed.data;
          const identity = await this.owners.threadIdentity.resolve(lookup, { allowProviderAdmission });
          result = { data: identity ? WorkbenchThreadIdentityResolutionSchema.parse({
            threadId: identity.threadId,
            projectId: identity.projectId,
            harness: identity.bindings[0]?.harness,
          }) : null };
          break;
        }
        case "sandbox-network/read": {
          const { id: projectId } = await this.owners.projects.resolveProjectById(requiredString(params, "projectId"));
          if (!this.owners.providers) throw new Error("Provider settings are unavailable.");
          const settings = await Promise.all(installedProviderKeys.map(async provider => {
            const setting = await this.owners.providers!.get(provider).configuration.sandboxNetwork?.read(projectId);
            return setting ? { ...setting, provider } : null;
          }));
          result = { data: settings.filter(setting => setting !== null) };
          break;
        }
        case "sandbox-network/update": {
          const parsed = WorkbenchSandboxNetworkUpdateSchema.safeParse(params);
          if (!parsed.success) throw new InvalidParamsError("Invalid sandbox network setting update.");
          const { provider: requestedProvider, ...input } = parsed.data;
          const { id: projectId } = await this.owners.projects.resolveProjectById(input.projectId);
          const provider = installedProviderKeys.find(provider => provider === requestedProvider);
          if (!provider) throw new InvalidParamsError("The requested provider is not installed.");
          const capability = this.owners.providers?.get(provider).configuration.sandboxNetwork;
          if (!capability) throw new InvalidParamsError("The requested provider does not expose sandbox network settings.");
          result = { data: [{ ...await capability.update({ ...input, projectId }), provider }] };
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
        case "questionnaire/respond":
          result = await this.owners.questionnaireResponses.respond(questionnaireRespondRequest(params));
          break;
        case "search/query": {
          let projectId = params.projectId === null || params.projectId === ""
            ? null
            : requiredString(params, "projectId");
          if (projectId) {
            try {
              projectId = (await this.owners.projects.resolveProjectById(projectId)).id;
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
        case "stats/read/detailed":
        case "stats/read/efficiency":
        case "stats/read/efficiency/v2": {
          const parsed = (request.method === "stats/read" ? WorkbenchStatsReadRequestSchema : WorkbenchStatsDetailedReadRequestSchema).safeParse(params);
          if (!parsed.success) throw new InvalidParamsError("Invalid stats request.");
          if (parsed.data.projectId) {
            try {
              parsed.data.projectId = (await this.owners.projects.resolveProjectById(parsed.data.projectId)).id;
            } catch (error) {
              throw new InvalidParamsError(error instanceof Error ? error.message : "Unknown project.");
            }
          }
          if (request.method === "stats/read") result = await this.owners.stats.read(parsed.data);
          else {
            const detailed = await this.owners.stats.readDetailed(parsed.data);
            result = request.method === "stats/read/detailed" ? detailedStatsResponse(detailed)
              : request.method === "stats/read/efficiency" ? cacheStatsResponse(detailed) : detailed;
          }
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
        case "agents/read": result = await this.owners.agents.readAgent(requiredString(params, "projectId"), requiredString(params, "agentPath"), requiredString(params, "provider")); break;
        case "skills/read": result = await this.owners.agents.readSkills(typeof params.projectId === "string" ? params.projectId : null, requiredString(params, "provider")); break;
        case "native/file/open": result = await this.owners.nativeFiles.open(openFileRequest(params)); break;
        case "native/file/reveal": result = await this.owners.nativeFiles.reveal({
          path: requiredString(params, "path"),
          projectId: requiredString(params, "projectId"),
        } satisfies RevealProjectEntryRequest); break;
        case "native/file/link-roots": result = await this.owners.nativeFiles.linkRoots(linkRootsRequest(params)); break;
        case "profiles/read": result = await this.owners.profiles.read(); break;
        case "profiles/target/read": {
          const slot = WorkbenchComposerProfileSlotInputSchema.safeParse(params.slot);
          if (!slot.success) throw new InvalidParamsError("slot must identify a composer profile target.");
          result = { selection: await this.owners.profileTargets.readComposerProfileTarget(await this.resolveProfileSlot(slot.data)) };
          break;
        }
        case "profiles/target/set": {
          const slot = WorkbenchComposerProfileSlotInputSchema.safeParse(params.slot);
          const selection = WorkbenchComposerProfileSelectionSchema.safeParse(params.selection);
          if (!slot.success) throw new InvalidParamsError("slot must identify a composer profile target.");
          if (!selection.success) throw new InvalidParamsError("selection must contain exact composer settings.");
          const target = await this.resolveProfileSlot(slot.data);
          const previous = selection.data.settings.contextWindowTokens == null ? null : await this.owners.profileTargets.readComposerProfileTarget(target);
          await this.validateContextWindow(selection.data.settings, previous?.settings ?? null);
          const ok = await this.owners.profileTargets.setComposerProfileTarget(
            target,
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
        }, (profile, previous) => this.validateContextWindow(profile, previous)); break;
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
          code: error instanceof InvalidParamsError ? -32602
            : error instanceof WorkbenchThreadHistoryPendingError ? WORKBENCH_THREAD_HISTORY_PENDING : -32000,
          ...(error instanceof GitArcFailureException ? { data: { gitArcFailure: error.failure } } : {}),
          message: error instanceof Error ? error.message : "Daemon request failed.",
        },
      };
    }
  }

  private async validateContextWindow(settings: WorkbenchComposerSettings, previous: WorkbenchComposerSettings | null) {
    const cap = settings.contextWindowTokens;
    if (cap == null || (previous?.harness === settings.harness && previous.model === settings.model && previous.contextWindowTokens === cap)) return;
    const key = installedProviderKeys.find(key => key === settings.harness);
    if (!key) throw new InvalidParamsError("The requested provider is unavailable.");
    if (!this.owners.providers) throw new Error("Model context capabilities are unavailable.");
    const capability = (await this.owners.providers.get(key).configuration.modelContext.read()).find((entry) => entry.model === settings.model);
    if (!capability) throw new InvalidParamsError("This model has no configurable context capability.");
    if (cap < capability.defaultTokens || cap > capability.maximumTokens || (cap - capability.defaultTokens) % 1000 !== 0) {
      throw new InvalidParamsError("Context window must be within the model bounds in 1K steps.");
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
