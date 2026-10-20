/*
 * Exports:
 * - threadRequestHandlers: daemon handlers for draft launches, presentation export, thread identity lookup, questionnaire answers and
 *   Browse sessions.
 */
import type { WorkbenchUserInputResponse } from "workbench-shared/types";
import type { WorkbenchQuestionnaireRespondRequest } from "workbench-shared/workbench/daemon/workbench-daemon-requests";
import { WorkbenchThreadLaunchReadSchema, WorkbenchThreadLaunchRequestSchema } from "workbench-shared/workbench/thread/thread-launch";
import {
  WorkbenchPresentationAttachmentChunkRequestSchema,
  WorkbenchPresentationExportRequestSchema,
  WorkbenchPresentationManifestRequestSchema,
} from "workbench-shared/workbench/thread/thread-presentation-export";
import {
  WorkbenchThreadIdentityResolutionSchema,
  WorkbenchThreadIdentityResolveRequestSchema,
} from "workbench-shared/workbench/thread/workbench-thread-identity";
import {
  defineDaemonRequestHandlers, InvalidParamsError, optionalFiniteNumber, optionalStringArray, optionalUserInput, record, requiredString,
  type DaemonRequestContext,
} from "./daemon-request-handler";

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
    skipAutoCompact: params.skipAutoCompact === true,
    supplementalInput: optionalUserInput(params, "supplementalInput"),
    threadId: requiredString(params, "threadId"),
    turnId: params.turnId == null ? null : requiredString(params, "turnId"),
  };
}

function launches({ owners }: DaemonRequestContext) {
  if (!owners.launches) throw new Error("Thread launch is unavailable.");
  return owners.launches;
}

function presentationExport({ owners }: DaemonRequestContext) {
  if (!owners.presentationExport) throw new Error("Presentation export is unavailable.");
  return owners.presentationExport;
}

function browse(context: DaemonRequestContext) {
  const port = context.browse();
  if (!port) throw new Error("Browse session management is reloading.");
  return port;
}

export const threadRequestHandlers = defineDaemonRequestHandlers({
  "thread/identity/resolve": async (params, { owners }) => {
    const parsed = WorkbenchThreadIdentityResolveRequestSchema.safeParse(params);
    if (!parsed.success) throw new InvalidParamsError("Invalid thread identity lookup.");
    const { allowProviderAdmission, ...lookup } = parsed.data;
    const identity = await owners.threadIdentity.resolve(lookup, { allowProviderAdmission });
    return { data: identity ? WorkbenchThreadIdentityResolutionSchema.parse({
      threadId: identity.threadId,
      projectId: identity.projectId,
      harness: identity.bindings[0]?.harness,
    }) : null };
  },
  "thread/launch": async (params, context) => {
    const owner = launches(context);
    return await owner.launch(WorkbenchThreadLaunchRequestSchema.parse(params));
  },
  "thread/launch/read": async (params, context) => {
    const owner = launches(context);
    return { state: await owner.read(WorkbenchThreadLaunchReadSchema.parse(params).launchId) };
  },
  "thread/presentation/export": async (params, context) => {
    const owner = presentationExport(context);
    return await owner.exportPresentationPage(WorkbenchPresentationExportRequestSchema.parse(params));
  },
  "thread/presentation/manifest/read": async (params, context) => {
    const owner = presentationExport(context);
    return await owner.exportPresentationManifestPage(WorkbenchPresentationManifestRequestSchema.parse(params));
  },
  "thread/presentation/attachment/read": async (params, context) => {
    const owner = presentationExport(context);
    return await owner.readPresentationAttachmentChunk(WorkbenchPresentationAttachmentChunkRequestSchema.parse(params));
  },
  "questionnaire/respond": async (params, { owners }) => await owners.questionnaireResponses.respond(questionnaireRespondRequest(params)),
  "browse/sessions/read": async (params, context) => await browse(context).listSessions(params),
  "browse/sessions/forget": async (params, context) => await browse(context).controlSession({ ...params, action: "forget" }),
  "browse/sessions/stop": async (params, context) => await browse(context).controlSession({ ...params, action: "stop" }),
});
