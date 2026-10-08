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
    type WorkbenchDaemonMethod,
    type WorkbenchQuestionnaireRespondRequest,
} from "workbench-shared/workbench/daemon/workbench-daemon-requests";
import type { REPO_RUNTIME_READ_METHOD } from "workbench-shared/workbench/repo/virtual-repo-contract";
import { WorkbenchUserInputSchema } from "workbench-shared/workbench/provider/provider-input";
import { ThreadAutoCompactSettingsPatchSchema } from "workbench-shared/workbench/settings/thread-auto-compact";
import type WorkbenchModelUsageStore from "./WorkbenchModelUsageStore";
import { CommandApprovalPatchSchema, CommandApprovalRemoveSchema } from "workbench-shared/workbench/settings/command-approvals";
import { ApprovalReviewSettingsUpdateSchema } from "workbench-shared/workbench/approval-review/approval-review-settings";
import { ProjectDiscoverySettingsUpdateSchema } from "workbench-shared/workbench/project/project-discovery-settings";
import { ProjectCreateRequestSchema, ProjectFolderListRequestSchema } from "workbench-shared/workbench/project/project-creation";
import { WorkbenchProjectFileIndexRequestSchema } from "workbench-shared/workbench/project/project-file-index";
import { ProjectStoreReadRequestSchema, ProjectStoreUpdateRequestSchema } from "workbench-shared/workbench/project/project-store";
import ProjectTreeFileIndex from "workbench-shared/workbench/project/ProjectTreeFileIndex";
import { WorkbenchProjectStateRequestSchema } from "workbench-shared/workbench/project/project-state";
import { WorkbenchThreadLaunchReadSchema, WorkbenchThreadLaunchRequestSchema } from "workbench-shared/workbench/thread/thread-launch";
import {
  WorkbenchPresentationAttachmentChunkRequestSchema,
  WorkbenchPresentationExportRequestSchema,
  WorkbenchPresentationLayoutChunkRequestSchema,
  WorkbenchPresentationManifestRequestSchema,
} from "workbench-shared/workbench/thread/thread-presentation-export";
import type WorkbenchThreadLaunchController from "./WorkbenchThreadLaunchController";
import { WORKBENCH_GIT_ARC_RESULT_SCHEMAS } from "workbench-shared/workbench/daemon/git-arc-result-schemas";
import {
    createGitArcOperationRejected,
    GitArcFailureException,
    parseGitArcFailureEnvelope,
} from "workbench-shared/workbench/git/git-arc-failures";
import { WorkbenchComposerProfileSelectionSchema, WorkbenchComposerProfileSlotInputSchema } from "workbench-shared/workbench/thread/thread-state";
import { isSelectableContextWindow } from "workbench-shared/workbench/thread/thread-profile";
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
import type WorkbenchProjectCreationController from "./WorkbenchProjectCreationController";
import type WorkbenchProjectFileController from "./WorkbenchProjectFileController";
import type WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import type WorkbenchSearchController from "./WorkbenchSearchController";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type WorkbenchQuestionnaireResponseController from "./WorkbenchQuestionnaireResponseController";
import type WorkbenchThreadAutoCompactController from "./WorkbenchThreadAutoCompactController";
import type WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import type WorkbenchThreadActionController from "./WorkbenchThreadActionController";
import { workbenchThreadActions, WorkbenchTranscriptRecoveryRequiredError, WORKBENCH_TRANSCRIPT_RECOVERY_REQUIRED } from "workbench-shared/workbench/thread/thread-actions";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { z } from "zod";
import { WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { WorkbenchThreadHistoryPendingError, WORKBENCH_THREAD_HISTORY_PENDING } from "workbench-shared/workbench/provider/provider-thread";

export interface WorkbenchBrowseSessionPort {
  controlSession(params: object): Promise<object>;
  listSessions(params: object): Promise<object>;
}

/** Typed daemon methods this controller's switch owns; voice and repo runtime stay with the socket controller. */
type DaemonRequestMethod = Exclude<
  WorkbenchDaemonMethod,
  keyof typeof workbenchThreadActions | WorkbenchDaemonGitArcMethod | `voice/${string}` | typeof REPO_RUNTIME_READ_METHOD
>;

// Typed so adding a method to WorkbenchDaemonRequestMap fails typecheck until it is accepted here.
const REQUEST_METHODS = {
  "installation/update/pull": true, "installation/update/failure/dismiss": true,
  "project/tree/refresh": true, "project/entry/create": true, "project/file/delete": true,
  "git/working-tree/read": true, "git/working-tree/diff": true,
  "git/working-tree/preview": true, "git/working-tree/mutate": true,
  "models/context/read": true, "models/list": true, "account/limits/read": true,
  "agents/list": true, "agents/read": true,
  "browse/sessions/forget": true, "browse/sessions/read": true, "browse/sessions/stop": true,
  "sandbox-network/read": true, "sandbox-network/update": true,
  "command-approvals/read": true, "command-approvals/remove": true, "command-approvals/patch": true,
  "approval-review/read": true, "approval-review/update": true,
  "project/store/read": true, "project/store/update": true,
  "project/discovery-settings/read": true, "project/discovery-settings/update": true,
  "project/folders/list": true, "project/create": true,
  "local-capabilities/read": true, "local-capabilities/update": true,
  "thread-auto-compact/read": true, "thread-auto-compact/update": true,
  "native/file/link-roots": true, "native/file/open": true, "native/file/reveal": true,
  "profiles/delete": true, "profiles/read": true, "profiles/target/read": true, "profiles/target/set": true, "profiles/upsert": true,
  "project/catalog/read": true, "project/file-index/read": true, "project/locations/read": true,
  "thread/launch": true, "thread/launch/read": true,
  "thread/presentation/export": true, "thread/presentation/attachment/read": true,
  "thread/presentation/layout/read": true, "thread/presentation/manifest/read": true,
  "project/file/read": true, "project/file/reset": true, "project/file/save": true,
  "questionnaire/respond": true,
  "search/query": true,
  "stats/import/start": true, "stats/rate-limits/refresh": true, "stats/feedback/delete": true,
  "skills/read": true,
  "thread/identity/resolve": true,
} as const satisfies Record<DaemonRequestMethod, true>;

const METHODS = new Set<string>([
  ...Object.keys(REQUEST_METHODS),
  ...Object.keys(workbenchThreadActions),
  ...Object.keys(WORKBENCH_GIT_ARC_ACTION_BY_METHOD),
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
  private readonly installationUpdateRegistrations = new Set<Pick<import("./WorkbenchInstallationUpdateController").default, "pull" | "dismissFailure">>();

  private get installationUpdate() { return [...this.installationUpdateRegistrations].at(-1) ?? null; }

  constructor(private readonly owners: {
    autoCompact?: Pick<WorkbenchThreadAutoCompactController, "refreshObserved">;
    commandApprovals?: Pick<import("./WorkbenchCommandApprovalController").default, "list" | "remove" | "patch">;
    approvalReview?: Pick<import("./approval-review/WorkbenchApprovalReviewController").default, "read" | "update">;
    projectStore?: Pick<import("./store/WorkbenchProjectStore").default, "read" | "update">;
    providers?: Pick<WorkbenchProviderDispatcher, "get">;
    threadActions?: Pick<WorkbenchThreadActionController, "handle">;
    launches?: Pick<WorkbenchThreadLaunchController, "launch" | "read">;
    presentationExport?: Pick<WorkbenchThreadStateController,
      "exportPresentationPage" | "exportPresentationManifestPage"
      | "readPresentationAttachmentChunk" | "exportPresentationLayoutChunk">;
    agents: Pick<WorkbenchAgentSkillCatalogController, "listAgents" | "readAgent" | "readSkills">;
    files: Pick<WorkbenchProjectFileController, "read" | "write">;
    gitArc: Pick<WorkbenchGitArcFeature, "executeRequest">;
    workingTree?: Pick<WorkbenchWorkingTreeController, "read" | "summary" | "diff" | "preview" | "mutate">;
    nativeFiles: Pick<WorkbenchNativeFileController, "linkRoots" | "open" | "reveal">;
    profiles: Pick<WorkbenchComposerProfileStore, "mutate" | "read">;
    modelUsage: Pick<WorkbenchModelUsageStore, "read">;
    profileTargets: Pick<WorkbenchThreadStateController, "readComposerProfileTarget" | "setComposerProfileTarget">;
    projects: Pick<WorkbenchProjectCatalogController, "readCatalog" | "readLocations" | "resolveProjectById" | "readDiscoverySettings" | "updateDiscoverySettings">;
    projectCreation?: Pick<WorkbenchProjectCreationController, "listFolders" | "create">;
    projectSnapshot: Pick<WorkbenchProjectSnapshotController, "readProjectSnapshot" | "handleRequest">;
    search: Pick<WorkbenchSearchController, "search">;
    stats: Pick<WorkbenchStatsController, "deleteFeedback" | "observeAccountLimits" | "refreshRateLimits" | "startImport">;
    settings: Pick<WorkbenchServerSettings, "readLocalCapabilities" | "updateLocalCapabilities" | "readThreadAutoCompact" | "updateThreadAutoCompact">;
    threadIdentity: { resolve: WorkbenchHarnessController["resolveThreadIdentity"] };
    questionnaireResponses: Pick<WorkbenchQuestionnaireResponseController, "respond">;
  }) {}

  accepts(method: string) { return METHODS.has(method); }
  registerBrowse(port: WorkbenchBrowseSessionPort) { this.browse = port; return () => { if (this.browse === port) this.browse = null; }; }
  registerInstallationUpdate(port: Pick<import("./WorkbenchInstallationUpdateController").default, "pull" | "dismissFailure">) {
    this.installationUpdateRegistrations.add(port);
    return () => { this.installationUpdateRegistrations.delete(port); };
  }

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
      const method = request.method as DaemonRequestMethod;
      switch (method) {
        case "project/tree/refresh":
        case "project/entry/create":
        case "project/file/delete": {
          const project = await this.owners.projects.resolveProjectById(requiredString(params, "projectId"));
          const methods = {
            "project/tree/refresh": "workbench/thread-state/project/refresh",
            "project/entry/create": "workbench/thread-state/project/entry/create",
            "project/file/delete": "workbench/thread-state/project/file/delete",
          } as const;
          const operation = WorkbenchProjectStateRequestSchema.parse({
            ...params, projectId: project.id, method: methods[method],
          });
          result = await this.owners.projectSnapshot.handleRequest(project.id, operation);
          break;
        }
        case "project/discovery-settings/read": {
          result = await this.owners.projects.readDiscoverySettings();
          break;
        }
        case "project/discovery-settings/update": {
          const parsed = ProjectDiscoverySettingsUpdateSchema.safeParse(params);
          if (!parsed.success) throw new InvalidParamsError("Invalid project discovery settings.");
          result = await this.owners.projects.updateDiscoverySettings(parsed.data.paths);
          break;
        }
        case "project/folders/list": {
          if (!this.owners.projectCreation) throw new Error("Project creation is unavailable.");
          const parsed = ProjectFolderListRequestSchema.safeParse(params);
          if (!parsed.success) throw new InvalidParamsError("Invalid folder listing request.");
          result = await this.owners.projectCreation.listFolders(parsed.data.path);
          break;
        }
        case "project/create": {
          if (!this.owners.projectCreation) throw new Error("Project creation is unavailable.");
          const parsed = ProjectCreateRequestSchema.safeParse(params);
          if (!parsed.success) throw new InvalidParamsError("Invalid project creation request.");
          result = await this.owners.projectCreation.create(parsed.data);
          break;
        }
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
          result = method.endsWith("/diff") ? await this.owners.workingTree.diff(input) : await this.owners.workingTree.preview(input);
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
          if (method === "models/list") {
            const models = await provider.configuration.models.read();
            let used = new Map<string, number>();
            try {
              used = new Map((await this.owners.modelUsage.read(Date.now()))
                .filter(entry => entry.harness === key)
                .map(entry => [entry.modelId, entry.lastUsedAt]));
            } catch {
              console.warn("Unable to read model usage while listing models.");
            }
            result = { data: models.map(model => ({
              ...model,
              lastUsedAt: [model.id, ...(model.aliases ?? [])].reduce<number | null>((latest, id) => {
                const time = used.get(id);
                return time === undefined ? latest : Math.max(latest ?? time, time);
              }, null),
            })) };
          } else if (method === "models/context/read") {
            result = { data: await provider.configuration.modelContext.read() };
          } else {
            if (!provider.account) throw new InvalidParamsError("The provider does not report account limits.");
            const limits = await provider.account.limits.read();
            this.owners.stats.observeAccountLimits(key, limits);
            result = limits;
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
        case "command-approvals/read":
        case "command-approvals/remove":
        case "command-approvals/patch": {
          const { id: projectId } = await this.owners.projects.resolveProjectById(requiredString(params, "projectId"));
          if (!this.owners.commandApprovals) throw new Error("Command approvals are unavailable.");
          if (method === "command-approvals/remove") {
            const parsed = CommandApprovalRemoveSchema.safeParse({ ...params, projectId });
            if (!parsed.success) throw new InvalidParamsError("Invalid command approval removal.");
            await this.owners.commandApprovals.remove(projectId, parsed.data.id);
          }
          if (method === "command-approvals/patch") {
            const parsed = CommandApprovalPatchSchema.safeParse({ ...params, projectId });
            if (!parsed.success) throw new InvalidParamsError("Invalid command approval patch.");
            result = { rules: await this.owners.commandApprovals.patch(
              projectId, parsed.data.workdir, parsed.data.add, parsed.data.removeIds,
            ) };
          } else {
            result = { rules: await this.owners.commandApprovals.list(projectId) };
          }
          break;
        }
        case "approval-review/read":
        case "approval-review/update": {
          if (!this.owners.approvalReview) throw new Error("Auto-approve settings are unavailable.");
          if (method === "approval-review/update") {
            const parsed = ApprovalReviewSettingsUpdateSchema.safeParse(params);
            if (!parsed.success) throw new InvalidParamsError("Invalid auto-approve settings update.");
            result = await this.owners.approvalReview.update(parsed.data);
          } else {
            result = await this.owners.approvalReview.read();
          }
          break;
        }
        case "project/store/read":
        case "project/store/update": {
          if (!this.owners.projectStore) throw new Error("The project store is unavailable.");
          if (method === "project/store/read") {
            const parsed = ProjectStoreReadRequestSchema.safeParse(params);
            if (!parsed.success) throw new InvalidParamsError("A project ID is required for project store reads.");
            result = await this.owners.projectStore.read(parsed.data.projectId);
          } else {
            const parsed = ProjectStoreUpdateRequestSchema.safeParse(params);
            if (!parsed.success) throw new InvalidParamsError(parsed.error.issues[0]?.message ?? "Invalid project store update.");
            result = await this.owners.projectStore.update(parsed.data);
          }
          break;
        }
        case "sandbox-network/read": {
          const projectId = params.projectId === undefined ? null
            : (await this.owners.projects.resolveProjectById(requiredString(params, "projectId"))).id;
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
          const projectId = input.projectId === undefined ? null
            : (await this.owners.projects.resolveProjectById(input.projectId)).id;
          const provider = installedProviderKeys.find(provider => provider === requestedProvider);
          if (!provider) throw new InvalidParamsError("The requested provider is not installed.");
          const capability = this.owners.providers?.get(provider).configuration.sandboxNetwork;
          if (!capability) throw new InvalidParamsError("The requested provider does not expose sandbox network settings.");
          const updated = input.scope === "global"
            ? await capability.update({ scope: "global", enabled: input.enabled,
              ...(projectId ? { projectId } : {}) })
            : await capability.update({ scope: "project", enabled: input.enabled, projectId: projectId! });
          result = { data: [{ ...updated, provider }] };
          break;
        }
        case "installation/update/pull":
          if (!this.installationUpdate) throw new Error("Installation updates are unavailable.");
          result = await this.installationUpdate.pull();
          break;
        case "installation/update/failure/dismiss":
          if (!this.installationUpdate) throw new Error("Installation updates are unavailable.");
          result = await this.installationUpdate.dismissFailure();
          break;
        case "project/catalog/read": result = await this.owners.projects.readCatalog(); break;
        case "project/file-index/read": {
          const request = WorkbenchProjectFileIndexRequestSchema.safeParse(params);
          if (!request.success) throw new InvalidParamsError("A project ID is required for file-index reads.");
          const { projectId } = request.data;
          const snapshot = await this.owners.projectSnapshot.readProjectSnapshot(projectId);
          const index = ProjectTreeFileIndex.fromTree(snapshot.tree);
          result = { projectId, key: index.key, candidates: index.candidates };
          break;
        }
        case "project/locations/read": result = await this.owners.projects.readLocations(); break;
        case "thread/launch": {
          if (!this.owners.launches) throw new Error("Thread launch is unavailable.");
          result = await this.owners.launches.launch(WorkbenchThreadLaunchRequestSchema.parse(params));
          break;
        }
        case "thread/launch/read": {
          if (!this.owners.launches) throw new Error("Thread launch is unavailable.");
          result = { state: await this.owners.launches.read(WorkbenchThreadLaunchReadSchema.parse(params).launchId) };
          break;
        }
        case "thread/presentation/export": {
          if (!this.owners.presentationExport) throw new Error("Presentation export is unavailable.");
          result = await this.owners.presentationExport.exportPresentationPage(
            WorkbenchPresentationExportRequestSchema.parse(params));
          break;
        }
        case "thread/presentation/manifest/read": {
          if (!this.owners.presentationExport) throw new Error("Presentation export is unavailable.");
          result = await this.owners.presentationExport.exportPresentationManifestPage(
            WorkbenchPresentationManifestRequestSchema.parse(params));
          break;
        }
        case "thread/presentation/attachment/read": {
          if (!this.owners.presentationExport) throw new Error("Presentation export is unavailable.");
          result = await this.owners.presentationExport.readPresentationAttachmentChunk(
            WorkbenchPresentationAttachmentChunkRequestSchema.parse(params));
          break;
        }
        case "thread/presentation/layout/read": {
          if (!this.owners.presentationExport) throw new Error("Presentation export is unavailable.");
          result = await this.owners.presentationExport.exportPresentationLayoutChunk(
            WorkbenchPresentationLayoutChunkRequestSchema.parse(params));
          break;
        }
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
        case "stats/import/start":
          if (Object.keys(params).length) throw new InvalidParamsError("Stats import start does not accept parameters.");
          result = await this.owners.stats.startImport();
          break;
        case "stats/rate-limits/refresh":
          await this.owners.stats.refreshRateLimits();
          result = { ok: true };
          break;
        case "stats/feedback/delete": {
          const ids = z.object({ ids: z.array(z.number().int().positive()).min(1).max(WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT) }).strict().safeParse(params);
          if (!ids.success) throw new InvalidParamsError("Feedback deletion needs between 1 and 200 feedback ids.");
          result = { deleted: await this.owners.stats.deleteFeedback(ids.data.ids) };
          break;
        }
        case "local-capabilities/read": result = { localCapabilities: await this.owners.settings.readLocalCapabilities() }; break;
        case "thread-auto-compact/read": result = { settings: await this.owners.settings.readThreadAutoCompact() }; break;
        case "thread-auto-compact/update": {
          const edit = ThreadAutoCompactSettingsPatchSchema.safeParse(params.settings);
          if (!edit.success) throw new InvalidParamsError("Invalid auto-compact settings.");
          const settings = await this.owners.settings.updateThreadAutoCompact(edit.data);
          await this.owners.autoCompact?.refreshObserved();
          result = { settings };
          break;
        }
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
            action: method.endsWith("/forget") ? "forget" : "stop",
          });
          break;
        default:
          // Compile-time exhaustiveness; untyped wire methods still reach the runtime error.
          method satisfies never;
          return { id, error: { code: -32601, message: "Daemon method not found." } };
      }
      return { id, result };
    } catch (error) {
      return {
        id,
        error: {
          code: error instanceof InvalidParamsError ? -32602
            : error instanceof WorkbenchTranscriptRecoveryRequiredError ? WORKBENCH_TRANSCRIPT_RECOVERY_REQUIRED
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
    if (!isSelectableContextWindow(capability, cap)) {
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
    const parsed = WORKBENCH_GIT_ARC_RESULT_SCHEMAS[method].safeParse(published);
    if (!parsed.success) throw new Error(`The ${method} result did not match its contract.`);
    return parsed.data;
  }
}
