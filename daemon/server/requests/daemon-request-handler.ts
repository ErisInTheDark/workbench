/*
 * Exports:
 * - WorkbenchDaemonRequestOwners: the owners daemon request handlers call.
 * - WorkbenchBrowseSessionPort/ProviderRuntimePort/InstallationUpdatePort: ports that register and retire with their own reload nodes.
 * - DaemonRequestContext: what one handler receives besides its params.
 * - DaemonHandledMethod/DaemonRequestHandlers/defineDaemonRequestHandlers: the daemon methods this controller's handlers own, and their handler maps.
 * - InvalidParamsError: a request whose params are wrong (JSON-RPC -32602).
 * - requiredString/requiredText/optionalFiniteNumber/requiredFiniteNumber/optionalStringArray/optionalUserInput/record: params readers.
 */
import type { WorkbenchDaemonGitArcMethod, WorkbenchDaemonMethod } from "workbench-shared/workbench/daemon/workbench-daemon-requests";
import { WorkbenchUserInputSchema } from "workbench-shared/workbench/provider/provider-input";
import type { REPO_RUNTIME_READ_METHOD } from "workbench-shared/workbench/repo/virtual-repo-contract";
import type { workbenchThreadActions } from "workbench-shared/workbench/thread/thread-actions";
import type WorkbenchServerSettings from "../lib/workbench/settings/WorkbenchServerSettings";
import type WorkbenchStatsController from "../stats/WorkbenchStatsController";
import type WorkbenchAgentSkillCatalogController from "../agent/WorkbenchAgentSkillCatalogController";
import type WorkbenchComposerProfileStore from "../store/WorkbenchComposerProfileStore";
import type WorkbenchGitArcFeature from "../git/WorkbenchGitArcFeature";
import type WorkbenchHarnessController from "../providers/WorkbenchHarnessController";
import type WorkbenchModelUsageStore from "../store/WorkbenchModelUsageStore";
import type WorkbenchNativeFileController from "../project/WorkbenchNativeFileController";
import type WorkbenchProjectCatalogController from "../project/WorkbenchProjectCatalogController";
import type WorkbenchProjectCreationController from "../project/WorkbenchProjectCreationController";
import type WorkbenchProjectFileController from "../project/WorkbenchProjectFileController";
import type WorkbenchProjectSnapshotController from "../project/WorkbenchProjectSnapshotController";
import type WorkbenchProviderDispatcher from "../providers/WorkbenchProviderDispatcher";
import type WorkbenchQuestionnaireResponseController from "../interactions/WorkbenchQuestionnaireResponseController";
import type WorkbenchSearchController from "../project/WorkbenchSearchController";
import type WorkbenchThreadActionController from "../thread/WorkbenchThreadActionController";
import type WorkbenchThreadAutoCompactController from "../turn/WorkbenchThreadAutoCompactController";
import type WorkbenchThreadLaunchController from "../thread/WorkbenchThreadLaunchController";
import type WorkbenchThreadStateController from "../thread/WorkbenchThreadStateController";
import type WorkbenchWorkingTreeController from "../git/WorkbenchWorkingTreeController";

export interface WorkbenchBrowseSessionPort {
  controlSession(params: object): Promise<object>;
  listSessions(params: object): Promise<object>;
}

export type ProviderRuntimePort = Pick<import("../providers/ProviderRuntimeController").default, "read" | "install">;
export type InstallationUpdatePort = Pick<import("../runtime/WorkbenchInstallationUpdateController").default, "pull" | "dismissFailure">;

export interface WorkbenchDaemonRequestOwners {
  autoCompact?: Pick<WorkbenchThreadAutoCompactController, "refreshObserved">;
  commandApprovals?: Pick<import("../interactions/WorkbenchCommandApprovalController").default, "list" | "remove" | "patch">;
  approvalReview?: Pick<import("../approval-review/WorkbenchApprovalReviewController").default, "read" | "update">;
  mcpServers?: Pick<import("../mcp-servers/WorkbenchMcpServerController").default, "read" | "update" | "startSignIn" | "finishSignIn">;
  projectStore?: Pick<import("../store/WorkbenchProjectStore").default, "read" | "update">;
  providers?: Pick<WorkbenchProviderDispatcher, "get">;
  threadActions?: Pick<WorkbenchThreadActionController, "handle">;
  launches?: Pick<WorkbenchThreadLaunchController, "launch" | "read">;
  presentationExport?: Pick<WorkbenchThreadStateController,
    "exportPresentationPage" | "exportPresentationManifestPage" | "readPresentationAttachmentChunk">;
  agents: Pick<WorkbenchAgentSkillCatalogController, "listAgents" | "readAgent" | "readSkills">;
  files: Pick<WorkbenchProjectFileController, "read" | "write">;
  gitArc: Pick<WorkbenchGitArcFeature, "executeRequest">;
  workingTree?: Pick<WorkbenchWorkingTreeController, "read" | "summary" | "diff" | "preview" | "mutate">;
  branchPositions?: Pick<import("../git/WorkbenchBranchPositionController").default, "push">;
  gitCheckout?: Pick<import("../git/WorkbenchGitCheckoutController").default, "detail" | "diff" | "preview" | "mutate">;
  nativeFiles: Pick<WorkbenchNativeFileController, "linkRoots" | "open" | "reveal">;
  profiles: Pick<WorkbenchComposerProfileStore, "mutate" | "read">;
  modelUsage: Pick<WorkbenchModelUsageStore, "read">;
  profileTargets: Pick<WorkbenchThreadStateController, "readComposerProfileTarget" | "setComposerProfileTarget">;
  projects: Pick<WorkbenchProjectCatalogController, "readCatalog" | "readLocations" | "resolveProjectById" | "readDiscoverySettings" | "updateDiscoverySettings">;
  projectCreation?: Pick<WorkbenchProjectCreationController, "listFolders" | "create">;
  projectSnapshot: Pick<WorkbenchProjectSnapshotController, "readProjectSnapshot" | "handleRequest">;
  search: Pick<WorkbenchSearchController, "search">;
  stats: Pick<WorkbenchStatsController, "deleteFeedback" | "observeAccountLimits" | "refreshRateLimits" | "resolveFeedback" | "startImport">;
  settings: Pick<WorkbenchServerSettings, "readLocalCapabilities" | "updateLocalCapabilities" | "readThreadAutoCompact" | "updateThreadAutoCompact">;
  threadIdentity: { resolve: WorkbenchHarnessController["resolveThreadIdentity"] };
  questionnaireResponses: Pick<WorkbenchQuestionnaireResponseController, "respond">;
}

export interface DaemonRequestContext {
  owners: WorkbenchDaemonRequestOwners;
  /** Null while its node reloads. */
  browse(): WorkbenchBrowseSessionPort | null;
  installationUpdate(): InstallationUpdatePort | null;
  providerRuntimes(): ProviderRuntimePort | null;
}

/** Daemon methods these handlers own; thread actions and Git arc dispatch generically, and voice and repo runtime stay with the socket controller. */
export type DaemonHandledMethod = Exclude<
  WorkbenchDaemonMethod,
  keyof typeof workbenchThreadActions | WorkbenchDaemonGitArcMethod | `voice/${string}` | typeof REPO_RUNTIME_READ_METHOD
>;

export type DaemonRequestHandlers<Method extends DaemonHandledMethod> = {
  [Key in Method]: (params: Record<string, unknown>, context: DaemonRequestContext) => Promise<object>;
};

export function defineDaemonRequestHandlers<Method extends DaemonHandledMethod>(handlers: DaemonRequestHandlers<Method>) {
  return handlers;
}

export class InvalidParamsError extends Error {}

export function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidParamsError("A daemon request object is required.");
  return value as Record<string, unknown>;
}

export function requiredString(params: Record<string, unknown>, name: string) {
  const value = typeof params[name] === "string" ? params[name].trim() : "";
  if (!value) throw new InvalidParamsError(`${name} is required.`);
  return value;
}

export function requiredText(params: Record<string, unknown>, name: string) {
  const value = params[name];
  if (typeof value !== "string") throw new InvalidParamsError(`${name} must be a string.`);
  return value;
}

export function optionalFiniteNumber(params: Record<string, unknown>, name: string) {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InvalidParamsError(`${name} must be a finite number.`);
  return value;
}

export function requiredFiniteNumber(params: Record<string, unknown>, name: string) {
  const value = optionalFiniteNumber(params, name);
  if (value === null) throw new InvalidParamsError(`${name} is required.`);
  return value;
}

export function optionalStringArray(params: Record<string, unknown>, name: string) {
  const value = params[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
    throw new InvalidParamsError(`${name} must be an array of strings.`);
  }
  return value;
}

export function optionalUserInput(params: Record<string, unknown>, name: string) {
  const value = params[name];
  if (value === undefined) return undefined;
  const parsed = WorkbenchUserInputSchema.array().safeParse(value);
  if (!parsed.success) throw new InvalidParamsError(`${name} must contain valid user input.`);
  return parsed.data;
}
