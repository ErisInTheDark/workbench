/*
 * Exports:
 * - mapWorkbenchProviderRequest: resolve public references at ingress without changing payload or send ownership.
 * - mapNativeProviderResponse: project declared provider response references through committed identities.
 * - mapNativeThreadStateSnapshot: retain canonical state and derive legacy draft wire aliases.
 * - mapNativeThreadStateResult: derive draft wire aliases in canonical open and context responses.
 * - mapWorkbenchThreadStateRequest: validate project ownership and admit canonical mutation and observation targets.
 * - NativeThreadStateIdentityOwners: committed identity lookup plus metadata-only cold admission.
 * - createWorkbenchQuestionnaireStatePorts: validate WB questionnaire ownership without live-turn admission.
 */
import type { WorkbenchHarness, WorkbenchThreadContextReadResponse, WorkbenchQuestionnaireHistoryEntry, WorkbenchPendingUserInputRequest } from "workbench-shared/types";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import { getWorkbenchLifecycleTurnId, serializeLegacyThreadDraft, WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import { WORKBENCH_THREAD_PAGE_READ_METHOD } from "workbench-shared/workbench/thread/workbench-thread-page";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import { mapProviderThread, mapProviderTurn } from "./thread-identity-provider-mapping";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { mapCodexTranscriptObservation as mapNativeTranscriptObservation } from "./CodexProviderObservations";
import type {
  WorkbenchThreadSidebarSnapshot, WorkbenchThreadStateSnapshot, WorkbenchDurableQuestionnaire,
  WorkbenchThreadStateRequest, WorkbenchThreadStateOpenResult, WorkbenchGlobalThreadStateOpenResult,
  WorkbenchPinnedThreadContextResult, WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import {
  getProjectQualifiedThreadDisplayKey, parseProjectQualifiedThreadDisplayKey,
  getThreadDisplayThreadKey,
} from "workbench-shared/workbench/thread/thread-display-layout";
import { z } from "zod";
import { resolveQuestionnaireHistoryItemId } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";
import { ItemReferenceSchema, NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema, ThreadReferenceSchema, TurnReferenceSchema, WorkbenchItemIdSchema } from "workbench-shared/workbench/identity";
import type { NativeThreadId, ProjectId, WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type { WorkbenchQuestionnaireControllerOptions } from "./WorkbenchQuestionnaireController";

export function createWorkbenchQuestionnaireStatePorts(
  owners: NativeTranscriptIdentityOwners,
  state: Pick<WorkbenchThreadStateController, "getCanonicalThreadEntry" | "setPendingQuestionnaire" | "clearPendingQuestionnaire" | "subscribe">,
  resolveProject: (cwd: string) => Promise<ProjectId>,
): Pick<WorkbenchQuestionnaireControllerOptions, "clearPending" | "publishPending" | "resolveThread" | "subscribePending"> {
  const { threads, items } = owners;
  const resolveThread = async (threadId: WorkbenchThreadId, projectId?: ProjectId) => {
    const thread = await threads.resolve({ threadId, ...(projectId ? { projectId } : {}) });
    if (!thread) throw new Error("The questionnaire caller has no admitted thread identity.");
    return thread;
  };
  return {
    clearPending: async (threadId, requestKey) => {
      const thread = await resolveThread(threadId);
      await state.clearPendingQuestionnaire(thread.projectId, thread.threadId, requestKey);
    },
    publishPending: async (threadId, questionnaire) => {
      const thread = await resolveThread(threadId);
      const turn = questionnaire.turnId === null ? null : await threads.resolveTurn({ threadId: thread.threadId, turnId: questionnaire.turnId });
      if (questionnaire.turnId !== null && !turn) throw new Error("The questionnaire turn has no admitted identity.");
      // Workbench allocates this UUID before publishing the request. Commit its
      // identity first so pending state can reference it without a transcript body.
      let itemId = null;
      if (questionnaire.itemId !== null) {
        const [item] = await items.admit([{
          itemId: WorkbenchItemIdSchema.parse(questionnaire.itemId), threadId: thread.threadId,
          sources: [], legacyAliases: [],
        }]);
        if (!item) throw new Error("The questionnaire item identity was not admitted.");
        itemId = item.itemId;
      }
      const canonical = { ...questionnaire, itemId, turnId: turn?.turnId ?? null };
      await state.setPendingQuestionnaire(thread.projectId, thread.threadId, canonical);
    },
    resolveThread: async (cwd, threadId) => {
      const projectId = await resolveProject(cwd);
      const thread = await resolveThread(threadId, projectId);
      const entry = await state.getCanonicalThreadEntry(projectId, thread.threadId);
      if (!entry || entry.entryKind === "draft") throw new Error("The questionnaire caller has no stored thread in this cwd project.");
      const pending = entry.pendingQuestionnaire;
      const lifecycleTurnId = getWorkbenchLifecycleTurnId(entry.lifecycle);
      return {
        projectId,
        turnId: lifecycleTurnId,
        pendingQuestionnaire: pending,
      };
    },
    subscribePending: listener => state.subscribe((projectId, entry) => {
      if (entry.entryKind === "draft") return;
      const thread = threads.knownThread(entry.identity.threadId);
      if (thread.projectId !== projectId) throw new Error("Questionnaire observation crossed project ownership.");
      listener({ projectId: thread.projectId, requestKey: entry.pendingQuestionnaire?.requestKey ?? null, threadId: thread.threadId });
    }),
  };
}

export type NativeThreadStateIdentityOwners = NativeTranscriptIdentityOwners
  & Partial<Pick<WorkbenchHarnessController, "resolveThreadIdentity" | "resolveTurnIdentity">>;

const admissionRequests = {
  resumeRequest: "thread/resume",
  startRequest: "turn/start",
  steerRequest: "turn/steer",
} as const;

type ThreadIdentity = { harness: WorkbenchHarness; threadId: string };

async function resolveNativeReference(owners: NativeThreadStateIdentityOwners, identity: { threadId: string; harness?: WorkbenchHarness }, projectId?: string) {
  const input = { ...identity, threadId: ThreadReferenceSchema.parse(identity.threadId), ...(projectId ? { projectId: ProjectIdSchema.parse(projectId) } : {}) };
  try {
    const thread = await owners.threads.resolve(input)
      ?? (identity.harness ? await owners.resolveThreadIdentity?.(input) : null);
    if (!thread) throw new Error("Thread metadata has not been admitted for public projection.");
    // The scoped resolver owns alias-aware project validation. Comparing its
    // canonical result with the original address would reject retained aliases.
    return thread;
  } catch (cause) {
    const context = Object.fromEntries(Object.entries(input).map(([key, value]) => [
      key, value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 160),
    ]));
    const detail = (cause instanceof Error ? cause.message : "Identity lookup failed")
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 500);
    throw new Error(`Thread identity projection ${JSON.stringify(context)}: ${detail}`, { cause });
  }
}

async function mapNativeTurnReference(owners: NativeThreadStateIdentityOwners, identity: ThreadIdentity, turnId: string) {
  const thread = await resolveNativeReference(owners, identity);
  const turn = await owners.threads.resolveTurn({ threadId: thread.threadId, turnId: TurnReferenceSchema.parse(turnId) })
    ?? await owners.resolveTurnIdentity?.({ ...identity, threadId: ThreadReferenceSchema.parse(identity.threadId), turnId: TurnReferenceSchema.parse(turnId) });
  if (!turn) throw new Error("Turn metadata has not been admitted for public projection.");
  return turn.turnId;
}

async function mapNativeQuestionnaire(owners: NativeTranscriptIdentityOwners, identity: ThreadIdentity, questionnaire: Omit<WorkbenchDurableQuestionnaire, "turnId"> & { turnId: string | null }) {
  const thread = await resolveNativeReference(owners, identity);
  const turnId = questionnaire.turnId === null ? null : await mapNativeTurnReference(owners, identity, questionnaire.turnId);
  let itemId = questionnaire.itemId;
  if (itemId !== null) {
    const reference = ItemReferenceSchema.parse(itemId);
    const known = turnId ? owners.items.findItemIdForReference(thread.threadId, turnId, reference) : undefined;
    const existing = known ? null : await owners.items.resolve({ threadId: thread.threadId, itemId: reference, ...(turnId ? { turnId } : {}) });
    if (known || existing) itemId = known ?? existing!.itemId;
    else {
      if (!turnId && !z.uuid().safeParse(itemId).success) throw new Error("Legacy questionnaire item has no owning turn.");
      const [admitted] = await owners.items.admit([{
        threadId: thread.threadId,
        ...(z.uuid().safeParse(itemId).success ? { itemId: WorkbenchItemIdSchema.parse(itemId) } : {}),
        sources: turnId ? [{ turnId, kind: "stable", sourceId: itemId }] : [],
        legacyAliases: [],
      }]);
      itemId = admitted!.itemId;
    }
  }
  return { ...questionnaire, turnId, itemId };
}

async function mapNativeQuestionnaireHistory(owners: NativeTranscriptIdentityOwners, identity: ThreadIdentity, entry: WorkbenchQuestionnaireHistoryEntry): Promise<WorkbenchQuestionnaireHistoryEntry> {
  const thread = await resolveNativeReference(owners, identity);
  const questionnaire = await mapNativeQuestionnaire(owners, identity, { ...entry, itemId: resolveQuestionnaireHistoryItemId(entry) });
  const turnId = questionnaire.turnId!;
  let insertAfterItemId = entry.insertAfterItemId;
  if (insertAfterItemId !== null) {
    const reference = ItemReferenceSchema.parse(insertAfterItemId);
    const known = owners.items.findItemIdForReference(thread.threadId, turnId, reference);
    const existing = known ? null : await owners.items.resolve({ threadId: thread.threadId, turnId, itemId: reference });
    if (!known && !existing && entry.insertAfterItemIndex === null) throw new Error("Legacy questionnaire placement has no resolved item or position.");
    insertAfterItemId = known ?? existing?.itemId ?? null;
  }
  // This is the retained JSON renderer's placement input, not SQLite ordering.
  return { ...entry, ...questionnaire, threadId: thread.threadId, turnId, insertAfterItemId };
}

async function mapThreadDisplayKey(
  owners: NativeTranscriptIdentityOwners, key: string, projectId: string | undefined,
): Promise<string> {
  const qualified = projectId ? null : parseProjectQualifiedThreadDisplayKey(key);
  const localKey = qualified?.threadKey ?? key;
  const ownerProjectId = qualified?.projectId ?? projectId;
  if (localKey.startsWith("folder:") || localKey.startsWith("draft:")) return key;
  const reference = /^([^:]+):(.+)$/u.exec(localKey);
  if (!reference) return key;
  const harness = WorkbenchHarnessSchema.parse(reference[1]);
  const thread = await resolveNativeReference(owners, { harness, threadId: reference[2]! }, ownerProjectId);
  const mapped = getThreadDisplayThreadKey(harness, thread.threadId);
  return qualified ? getProjectQualifiedThreadDisplayKey(qualified.projectId, mapped) : mapped;
}

function mapNativeSidebar(sidebar: WorkbenchThreadSidebarSnapshot): WorkbenchThreadSidebarSnapshot {
  return {
    ...sidebar,
    entries: sidebar.entries.map(entry => entry.entryKind === "draft"
      ? { ...entry, draft: serializeLegacyThreadDraft(entry.draft) } : entry),
  };
}

export async function mapNativeThreadStateSnapshot(_owners: NativeThreadStateIdentityOwners, snapshot: WorkbenchThreadStateSnapshot): Promise<WorkbenchThreadStateSnapshot> {
  if (!("updateKind" in snapshot)) return mapNativeSidebar(snapshot);
  switch (snapshot.updateKind) {
    case "threadStateDelta": return {
      ...snapshot,
      upserts: snapshot.upserts.map(entry => entry.entryKind === "draft"
        ? { ...entry, draft: serializeLegacyThreadDraft(entry.draft) } : entry),
    };
    case "projectThreadSidebar": return { ...snapshot, sidebar: mapNativeSidebar(snapshot.sidebar) };
    default: return snapshot;
  }
}

async function mapThreadTarget(owners: NativeTranscriptIdentityOwners, target: WorkbenchThreadTarget, projectId: string | undefined): Promise<WorkbenchThreadTarget> {
  if (target.kind === "draft" || target.kind === "new") return target;
  const harness = target.harness ?? "codex";
  const map = async (threadId: string) => (await resolveNativeReference(owners, { harness, threadId }, projectId)).threadId;
  return {
    ...target, threadId: await map(target.threadId),
    ...(target.kind === "subagent" ? { parentThreadId: (await resolveNativeReference(owners, { threadId: target.parentThreadId }, projectId)).threadId } : {}),
  };
}

export async function mapNativeThreadStateResult(owners: NativeThreadStateIdentityOwners, value: unknown): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  let result = value as Record<string, unknown>;
  if ("sidebar" in result) {
    const opened = value as WorkbenchThreadStateOpenResult;
    result = { ...result, sidebar: mapNativeSidebar(opened.sidebar) };
  }
  if ("projectSidebars" in result) {
    const opened = value as WorkbenchGlobalThreadStateOpenResult;
    result = { ...result, projectSidebars: { ...opened.projectSidebars,
      projects: opened.projectSidebars.projects.map(mapNativeSidebar),
    } };
  }
  if ("context" in result) {
    const { context } = value as WorkbenchPinnedThreadContextResult;
    if (context) {
      result = { ...result, context: {
        ...context, entries: context.entries.map(entry => entry.entryKind === "draft"
          ? { ...entry, draft: serializeLegacyThreadDraft(entry.draft) } : entry),
      } };
    }
  }
  return result;
}

export async function mapWorkbenchThreadStateRequest(owners: NativeTranscriptIdentityOwners, request: WorkbenchThreadStateRequest): Promise<WorkbenchThreadStateRequest> {
  const projectId = "projectId" in request ? request.projectId : undefined;
  let result = request;
  if ("identity" in request) {
    const thread = await resolveNativeReference(owners, request.identity, projectId);
    const turn = "turnId" in request && request.turnId
      ? await owners.threads.resolveTurn({ threadId: thread.threadId, turnId: TurnReferenceSchema.parse(request.turnId) }) : null;
    if ("turnId" in request && request.turnId && !turn) throw new Error("Requested turn does not belong to the thread.");
    result = { ...result, identity: { ...request.identity, threadId: thread.threadId },
      ...("turnId" in request ? { turnId: turn?.turnId ?? request.turnId } : {}),
    } as WorkbenchThreadStateRequest;
  }
  if (request.method === "workbench/thread-state/pin/open") {
    result = { ...request, target: await mapThreadTarget(owners, request.target, request.projectId) };
  } else if (request.method === "workbench/thread-state/observe") {
    const target = await mapThreadTarget(owners, request.target, request.projectId);
    if (target.kind === "draft" || target.kind === "new") throw new Error("Thread observation routing changed its target kind.");
    result = { ...request, target };
  } else if (request.method === "workbench/thread-state/snooze/until") {
    const thread = await resolveNativeReference(owners, request.target.identity, request.target.projectId);
    result = { ...result, target: { ...request.target,
      identity: { ...request.target.identity, threadId: thread.threadId },
    } } as WorkbenchThreadStateRequest;
  }
  for (const field of ["sourceKey", "targetKey", "beforeKey", "destinationFolderKey"] as const) {
    if (field in request && typeof request[field as keyof typeof request] === "string") {
      const key = (request as Record<string, unknown>)[field] as string;
      result = { ...result, [field]: await mapThreadDisplayKey(owners, key, projectId) };
    }
  }
  if (request.method === "workbench/thread-state/questionnaire/resolve") {
    result = { ...result, entry: await mapNativeQuestionnaireHistory(owners, request.identity, {
      ...request.entry,
      itemId: request.entry.itemId ?? null,
      insertAfterItemId: request.entry.insertAfterItemId ?? null,
      insertAfterItemIndex: request.entry.insertAfterItemIndex ?? null,
    }) } as WorkbenchThreadStateRequest;
  }
  return result;
}

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
    const context = result as unknown as WorkbenchThreadContextReadResponse;
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
