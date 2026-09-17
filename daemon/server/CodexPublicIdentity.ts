/*
 * Exports:
 * - mapWorkbenchProviderRequest: translate WB references into one Codex execution.
 * - mapNativeProviderResponse: project native response references through committed WB identities.
 */
import type { WorkbenchHarness, WorkbenchPendingUserInputRequest } from "workbench-shared/types";
import type { CodexThreadContextReadResponse } from "workbench-shared/codex/thread-context";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import { WORKBENCH_THREAD_PAGE_READ_METHOD } from "workbench-shared/workbench/thread/workbench-thread-page";
import { NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema, ThreadReferenceSchema, TurnReferenceSchema } from "workbench-shared/workbench/identity";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { mapProviderThread, mapProviderTurn } from "./CodexProviderIdentity";
import { mapCodexTranscriptObservation as mapNativeTranscriptObservation } from "./CodexProviderObservations";
import { resolveNativeReference, mapNativeQuestionnaire, mapNativeQuestionnaireHistory } from "./thread-identity-workbench-mapping";


const admissionRequests = {
  resumeRequest: "thread/resume",
  startRequest: "turn/start",
  steerRequest: "turn/steer",
} as const;

export async function mapNativeProviderResponse(
  owners: NativeTranscriptIdentityOwners,
  harness: WorkbenchHarness,
  request: JsonRpcRequest,
  response: JsonRpcResponse,
): Promise<JsonRpcResponse> {
  if (response.error || !response.result || typeof response.result !== "object" || Array.isArray(response.result)) return response;
  const result = response.result as Record<string, unknown>;
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params as Record<string, unknown> : {};
  const native = () => {
    if (typeof params.threadId !== "string") throw new Error("Provider response requires its originating thread.");
    return owners.threads.knownNativeBinding(harness, NativeThreadIdSchema.parse(params.threadId));
  };
  if ((request.method === "thread/context/read" || request.method === WORKBENCH_THREAD_PAGE_READ_METHOD)
    && result.thread && (result.thread as Thread).id === owners.threads.workbenchIdForNative(native())) {
    return response;
  }
  let mapped = { ...result };
  if (typeof result.threadId === "string") {
    mapped.threadId = owners.threads.workbenchIdForNative(owners.threads.knownNativeBinding(harness, NativeThreadIdSchema.parse(result.threadId)));
  }
  if (result.thread) {
    const thread = result.thread as Thread;
    mapped.thread = mapProviderThread(owners, { harness, nativeLocation: thread.cwd }, thread);
  }
  if (request.method === "thread/list") {
    mapped.data = (result.data as Thread[]).map((thread) => mapProviderThread(owners, { harness, nativeLocation: thread.cwd }, thread));
  }
  if (request.method === "thread/turns/list") {
    mapped.data = (result.data as Turn[]).map((turn) => mapProviderTurn(owners, native(), turn));
  }
  if (request.method === "questionnaire/list") {
    const pending = result.data as Array<Omit<WorkbenchPendingUserInputRequest, "harness">>;
    mapped.data = await Promise.all(pending.map(async (entry) => {
      const identity = { harness, threadId: entry.threadId };
      const thread = await resolveNativeReference(owners, identity);
      return { ...entry, ...await mapNativeQuestionnaire(owners, identity, entry), threadId: thread.threadId };
    }));
  }
  if (result.turn) mapped.turn = mapProviderTurn(owners, native(), result.turn as Turn);
  if (typeof result.turnId === "string") {
    mapped.turnId = owners.threads.workbenchTurnIdForNative({ ...native(), nativeTurnId: NativeTurnIdSchema.parse(result.turnId) });
  }
  if (request.method === "thread/context/read" || request.method === WORKBENCH_THREAD_PAGE_READ_METHOD) {
    const context = result as unknown as CodexThreadContextReadResponse;
    const binding = native();
    const mapTurn = (nativeTurnId: string) => owners.threads.workbenchTurnIdForNative({ ...binding, nativeTurnId: NativeTurnIdSchema.parse(nativeTurnId) });
    mapped = {
      ...mapped,
      questionnaireEntries: await Promise.all(context.questionnaireEntries.map((entry) => (
        mapNativeQuestionnaireHistory(owners, { harness, threadId: binding.nativeThreadId }, entry)
      ))),
      steerEntries: context.steerEntries.map((entry) => {
        const fact = mapNativeTranscriptObservation(owners, binding, {
          kind: "steer", entry: { ...entry, threadId: NativeThreadIdSchema.parse(entry.threadId), turnId: NativeTurnIdSchema.parse(entry.turnId) },
          observedAt: entry.resolvedAt ?? entry.attemptedAt,
        });
        if (fact.kind !== "steer") throw new Error("Steer mapping changed its kind.");
        return fact.entry;
      }),
      browseResultEntries: context.browseResultEntries.map((entry) => {
        const fact = mapNativeTranscriptObservation(owners, binding, {
          kind: "browse", entry: { ...entry, threadId: NativeThreadIdSchema.parse(entry.threadId), turnId: NativeTurnIdSchema.parse(entry.turnId) },
        });
        if (fact.kind !== "browse") throw new Error("Browse mapping changed its kind.");
        return fact.entry;
      }),
      ...(context.entryScope?.mode === "turns" ? { entryScope: { ...context.entryScope, turnIds: context.entryScope.turnIds.map(mapTurn) } } : {}),
      ...(typeof result.nextCursor === "string" ? { nextCursor: mapTurn(result.nextCursor) } : {}),
    };
  }
  return { ...response, result: mapped };
}

export async function mapWorkbenchProviderRequest(
  threads: Pick<WorkbenchThreadIdentityController, "resolve" | "resolveTurn">,
  harness: WorkbenchHarness,
  request: JsonRpcRequest,
): Promise<{ harness: WorkbenchHarness; request: JsonRpcRequest }> {
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) return { harness, request };
  const params = request.params as Record<string, unknown>;
  if (typeof params.threadId !== "string" || !params.threadId.trim()) return { harness, request };
  const thread = await threads.resolve({
    threadId: ThreadReferenceSchema.parse(params.threadId), harness,
    ...(typeof params.projectId === "string" ? { projectId: ProjectIdSchema.parse(params.projectId) } : {}),
  });
  if (!thread) throw new Error("Workbench thread identity has not been observed.");
  const turnFields = request.method === WORKBENCH_THREAD_PAGE_READ_METHOD
    ? ["cursor", "turnId", "expectedTurnId"] : ["turnId", "expectedTurnId"];
  const turns = await Promise.all(turnFields.flatMap((field) => {
    const reference = params[field];
    if (typeof reference !== "string" || !reference.trim()) return [];
    return [(async () => {
      const turn = await threads.resolveTurn({ threadId: thread.threadId, turnId: TurnReferenceSchema.parse(reference.trim()) });
      if (!turn) throw new Error("Requested turn does not belong to the Workbench thread.");
      if (turn.native.nativeTurnId === null) throw new Error("Requested Workbench turn has no native execution.");
      return { field, turn };
    })()];
  }));
  const requestedTurnIds = request.method === "workbench/transcript/materialize" && Array.isArray(params.turnIds)
    ? await Promise.all(params.turnIds.map(async (turnId) => {
      if (typeof turnId !== "string") throw new Error("Transcript turn references must be strings.");
      const turn = await threads.resolveTurn({ threadId: thread.threadId, turnId: TurnReferenceSchema.parse(turnId) });
      if (!turn?.native.nativeTurnId) throw new Error("Requested transcript turn has no native execution.");
      return turn;
    })) : [];
  const native = turns[0]?.turn.native ?? requestedTurnIds[0]?.native ?? thread.bindings[0];
  if (!native) throw new Error("Workbench thread has no native destination.");
  const mappedParams: Record<string, unknown> = { ...params, threadId: native.nativeThreadId };
  for (const { field, turn } of turns) {
    if (turn.native.harness !== native.harness || turn.native.nativeLocation !== native.nativeLocation
      || turn.native.nativeThreadId !== native.nativeThreadId) {
      throw new Error("Requested turns belong to different native executions.");
    }
    mappedParams[field] = turn.native.nativeTurnId;
  }
  if (requestedTurnIds.length) {
    if (requestedTurnIds.some((turn) => turn.native.harness !== native.harness
      || turn.native.nativeLocation !== native.nativeLocation || turn.native.nativeThreadId !== native.nativeThreadId)) {
      throw new Error("Transcript materialisation must target one native execution per request.");
    }
    mappedParams.turnIds = requestedTurnIds.map((turn) => turn.native.nativeTurnId);
  }
  if (request.method === "workbench/codex/message/admit") {
    await Promise.all(Object.entries(admissionRequests).map(async ([field, method]) => {
      const nested = params[field];
      if (field === "steerRequest" && (nested === null || nested === undefined)) return;
      if (!nested || typeof nested !== "object" || Array.isArray(nested) || !("method" in nested) || nested.method !== method) {
        throw new Error(`Message admission requires its ${field}.`);
      }
      if (field === "steerRequest" && "params" in nested && nested.params
        && typeof nested.params === "object" && !Array.isArray(nested.params) && !("threadId" in nested.params)) {
        // This is a template, not a routed turn/steer. The admission owner supplies
        // the checked thread and current turn only after reading provider state.
        mappedParams[field] = nested;
        return;
      }
      const mapped = await mapWorkbenchProviderRequest(threads, harness, nested as JsonRpcRequest);
      const target = mapped.request.params as Record<string, unknown> | undefined;
      if (mapped.harness !== "codex" || native.harness !== "codex" || target?.threadId !== native.nativeThreadId) {
        throw new Error("Message admission requests must target the same thread.");
      }
      mappedParams[field] = mapped.request;
    }));
  }
  return { harness: WorkbenchHarnessSchema.parse(native.harness), request: { ...request, params: mappedParams } };
}
