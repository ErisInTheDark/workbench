/*
 * Exports:
 * - workbenchDaemonRequests: every daemon request other than thread actions, defined once in ./requests domain modules.
 * - WorkbenchDaemonMethod/WorkbenchDaemonRequestMap: typed browser-to-daemon request contract, thread actions included.
 * - WorkbenchDaemonParams/WorkbenchDaemonResult: method-indexed request and response types.
 * - getWorkbenchDaemonResultSchema/isWorkbenchDaemonResultParsed: a method's response schema and whether callers receive its parsed form.
 * - Re-exported contracts: WorkbenchQuestionnaireRespondRequest/Result, WorkbenchAgentDefinitionResponse, WorkbenchSkillCatalogResponse,
 *   WorkbenchInstructionPack, WorkbenchFileWriteResult, WorkbenchGitArcSuccess, WORKBENCH_GIT_ARC_ACTION_BY_METHOD/WorkbenchDaemonGitArcMethod.
 */
import type { z } from "zod";
import { workbenchThreadActions, type WorkbenchThreadActionMap } from "../thread/thread-actions.ts";
import type { DaemonRequestContract, DaemonRequestRoute } from "./define-daemon-request.ts";
import { gitDaemonRequests } from "./requests/git-requests.ts";
import { projectDaemonRequests } from "./requests/project-requests.ts";
import { providerDaemonRequests } from "./requests/provider-requests.ts";
import { settingsDaemonRequests } from "./requests/settings-requests.ts";
import { statsDaemonRequests } from "./requests/stats-requests.ts";
import { threadDaemonRequests } from "./requests/thread-requests.ts";
import { voiceDaemonRequests } from "./requests/voice-requests.ts";

export {
  WORKBENCH_GIT_ARC_ACTION_BY_METHOD, type WorkbenchDaemonGitArcMethod, type WorkbenchGitArcSuccess,
} from "./requests/git-requests.ts";
export type {
  WorkbenchAgentDefinitionResponse, WorkbenchFileWriteResult, WorkbenchInstructionPack, WorkbenchSkillCatalogResponse,
} from "./requests/project-requests.ts";
export type { WorkbenchQuestionnaireRespondRequest, WorkbenchQuestionnaireRespondResult } from "./requests/thread-requests.ts";

export const workbenchDaemonRequests = {
  ...gitDaemonRequests,
  ...projectDaemonRequests,
  ...providerDaemonRequests,
  ...settingsDaemonRequests,
  ...statsDaemonRequests,
  ...threadDaemonRequests,
  ...voiceDaemonRequests,
};

type RegisteredMethod = keyof typeof workbenchDaemonRequests;
type ContractTypes<Method extends RegisteredMethod> =
  typeof workbenchDaemonRequests[Method] extends DaemonRequestContract<infer Params, infer Result, DaemonRequestRoute>
    ? { params: Params; result: Result } : never;

export type WorkbenchDaemonRequestMap = WorkbenchThreadActionMap & { [Method in RegisteredMethod]: ContractTypes<Method> };
export type WorkbenchDaemonMethod = keyof WorkbenchDaemonRequestMap;
export type WorkbenchDaemonParams<TMethod extends WorkbenchDaemonMethod> = WorkbenchDaemonRequestMap[TMethod]["params"];
export type WorkbenchDaemonResult<TMethod extends WorkbenchDaemonMethod> = WorkbenchDaemonRequestMap[TMethod]["result"];

export function getWorkbenchDaemonResultSchema(method: WorkbenchDaemonMethod): z.ZodType {
  return method in workbenchThreadActions
    ? workbenchThreadActions[method as keyof typeof workbenchThreadActions].result
    : workbenchDaemonRequests[method as RegisteredMethod].result;
}

export function isWorkbenchDaemonResultParsed(method: WorkbenchDaemonMethod) {
  return method in workbenchDaemonRequests && (workbenchDaemonRequests[method as RegisteredMethod] as { parsed?: true }).parsed === true;
}
