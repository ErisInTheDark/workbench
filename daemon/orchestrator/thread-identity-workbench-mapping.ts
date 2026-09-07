/*
 * Keywords: Workbench identity, request routing, native adapter, turn ownership.
 * Exports:
 * - mapWorkbenchProviderRequest: resolve public references at ingress without changing payload or send ownership.
 * - mapNativeProviderResponse: project declared provider response references through committed identities.
 * - mapNativeThreadStateSnapshot: project sidebar, lifecycle and layout references without changing their owners.
 * - mapNativeThreadStateResult: project thread-state open and target responses.
 * - mapWorkbenchThreadStateRequest: resolve public mutation targets while retaining native storage keys.
 * - mapNativeSubagentResult: project relationship references before agent formatting.
 */
import type { WorkbenchHarness, WorkbenchThreadContextReadResponse, WorkbenchQuestionnaireHistoryEntry } from "workbench-shared/types";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import { WORKBENCH_THREAD_PAGE_READ_METHOD } from "workbench-shared/workbench/thread/workbench-thread-page";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import { mapProviderThread, mapProviderTurn } from "./thread-identity-provider-mapping";
import { mapNativeTranscriptObservation, type NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import type {
  WorkbenchThreadSidebarEntry, WorkbenchThreadSidebarSnapshot, WorkbenchThreadStateSnapshot,
  WorkbenchProjectThreadSummary, WorkbenchThreadLifecycle, WorkbenchDurableQuestionnaire,
  WorkbenchThreadStateRequest, WorkbenchThreadStateOpenResult, WorkbenchGlobalThreadStateOpenResult,
  WorkbenchPinnedThreadContextResult, WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import {
  getProjectQualifiedThreadDisplayKey, parseProjectQualifiedThreadDisplayKey,
  type ThreadDisplayLayout,
} from "workbench-shared/workbench/thread/thread-display-layout";
import { z } from "zod";
import { resolveQuestionnaireHistoryItemId } from "workbench-shared/workbench/thread/thread-questionnaire-identity";

const admissionRequests = {
  resumeRequest: "thread/resume",
  startRequest: "turn/start",
  steerRequest: "turn/steer",
} as const;

type ThreadIdentity = { harness: WorkbenchHarness; threadId: string };

export async function mapNativeSubagentResult(owners: NativeTranscriptIdentityOwners, value: unknown, projectId: string): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value } as Record<string, unknown>;
  const publicId = async (threadId: string) => {
    const identity = await owners.threads.resolve({ threadId, projectId });
    if (!identity) throw new Error("Subagent thread metadata is unavailable for public projection.");
    return identity.threadId;
  };
  if (typeof result.threadId === "string") result.threadId = await publicId(result.threadId);
  if (Array.isArray(result.settled)) {
    result.settled = await Promise.all((result.settled as Array<{ name: string; threadId: string }>).map(async (entry) => ({
      ...entry, threadId: await publicId(entry.threadId),
    })));
  }
  if (Array.isArray(result.subagents)) {
    result.subagents = await Promise.all((result.subagents as import("workbench-shared/types").WorkbenchSubagentSummary[]).map(async (entry) => ({
      ...entry, threadId: await publicId(entry.threadId), parentThreadId: await publicId(entry.parentThreadId),
      ...(entry.lifecycle ? { lifecycle: await mapNativeLifecycle(owners, { harness: entry.harness, threadId: entry.threadId }, entry.lifecycle) } : {}),
    })));
  }
  return result;
}

async function resolveNativeReference(owners: NativeTranscriptIdentityOwners, identity: ThreadIdentity, projectId?: string) {
  const native = owners.threads.findNativeBinding(identity.harness, identity.threadId);
  const known = native ? owners.threads.findNativeThread(native) : undefined;
  const thread = known ?? await owners.threads.resolve({ ...identity, ...(projectId ? { projectId } : {}) });
  if (!thread) throw new Error("Thread metadata has not been admitted for public projection.");
  if (projectId && thread.projectId !== projectId) throw new Error("Thread reference does not belong to the requested project.");
  return thread;
}

async function mapNativeTurnReference(owners: NativeTranscriptIdentityOwners, identity: ThreadIdentity, turnId: string) {
  const native = owners.threads.findNativeBinding(identity.harness, identity.threadId);
  const known = native ? owners.threads.findNativeTurn({ ...native, nativeTurnId: turnId }) : undefined;
  const thread = await resolveNativeReference(owners, identity);
  const turn = known ?? await owners.threads.resolveTurn({ threadId: thread.threadId, turnId });
  if (!turn) throw new Error("Turn metadata has not been admitted for public projection.");
  return turn.turnId;
}

async function mapNativeLifecycle(owners: NativeTranscriptIdentityOwners, identity: ThreadIdentity, lifecycle: WorkbenchThreadLifecycle): Promise<WorkbenchThreadLifecycle> {
  if ("agent" in lifecycle && lifecycle.agent?.turnId) {
    return { ...lifecycle, agent: { ...lifecycle.agent, turnId: await mapNativeTurnReference(owners, identity, lifecycle.agent.turnId) } } as WorkbenchThreadLifecycle;
  }
  return "turnId" in lifecycle ? { ...lifecycle, turnId: await mapNativeTurnReference(owners, identity, lifecycle.turnId) } : lifecycle;
}

async function mapNativeQuestionnaire(owners: NativeTranscriptIdentityOwners, identity: ThreadIdentity, questionnaire: WorkbenchDurableQuestionnaire) {
  const thread = await resolveNativeReference(owners, identity);
  const turnId = questionnaire.turnId === null ? null : await mapNativeTurnReference(owners, identity, questionnaire.turnId);
  let itemId = questionnaire.itemId;
  if (itemId !== null) {
    const known = turnId ? owners.items.findItemIdForReference(thread.threadId, turnId, itemId) : undefined;
    const existing = known ? null : await owners.items.resolve({ threadId: thread.threadId, itemId, ...(turnId ? { turnId } : {}) });
    if (known || existing) itemId = known ?? existing!.itemId;
    else {
      if (!turnId && !z.uuid().safeParse(itemId).success) throw new Error("Legacy questionnaire item has no owning turn.");
      const [admitted] = await owners.items.admit([{
        threadId: thread.threadId,
        ...(z.uuid().safeParse(itemId).success ? { itemId } : {}),
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
    const known = owners.items.findItemIdForReference(thread.threadId, turnId, insertAfterItemId);
    const existing = known ? null : await owners.items.resolve({ threadId: thread.threadId, turnId, itemId: insertAfterItemId });
    if (!known && !existing && entry.insertAfterItemIndex === null) throw new Error("Legacy questionnaire placement has no resolved item or position.");
    insertAfterItemId = known ?? existing?.itemId ?? null;
  }
  // This is the retained JSON renderer's placement input, not SQLite ordering.
  return { ...entry, ...questionnaire, threadId: thread.threadId, turnId, insertAfterItemId };
}

async function mapNativeSidebarEntry(owners: NativeTranscriptIdentityOwners, projectId: string, entry: WorkbenchThreadSidebarEntry): Promise<WorkbenchThreadSidebarEntry> {
  if (entry.entryKind === "draft") return entry;
  const thread = await resolveNativeReference(owners, entry.identity, projectId);
  const identity = { ...entry.identity, threadId: thread.threadId };
  const mapped = {
    ...entry, identity,
    lifecycle: await mapNativeLifecycle(owners, entry.identity, entry.lifecycle),
    ...(entry.pendingQuestionnaire ? { pendingQuestionnaire: await mapNativeQuestionnaire(owners, entry.identity, entry.pendingQuestionnaire) } : {}),
    ...(entry.questionnaireHistory ? { questionnaireHistory: await Promise.all(entry.questionnaireHistory.map((questionnaire) => (
      mapNativeQuestionnaireHistory(owners, entry.identity, {
        ...questionnaire, itemId: questionnaire.itemId ?? null,
        insertAfterItemId: questionnaire.insertAfterItemId ?? null,
        insertAfterItemIndex: questionnaire.insertAfterItemIndex ?? null,
      })
    ))) } : {}),
    ...(entry.gitArc?.members ? { gitArc: { ...entry.gitArc, members: await Promise.all(entry.gitArc.members.map(async (member) => ({
      ...member, threadId: (await resolveNativeReference(owners, { harness: WorkbenchHarnessSchema.parse(member.harness), threadId: member.threadId }, projectId)).threadId,
    }))) } } : {}),
    ...(entry.gitArcPlan?.members ? { gitArcPlan: { ...entry.gitArcPlan, members: await Promise.all(entry.gitArcPlan.members.map(async (member) => ({
      ...member, threadId: (await resolveNativeReference(owners, { harness: WorkbenchHarnessSchema.parse(member.harness), threadId: member.threadId }, projectId)).threadId,
    }))) } } : {}),
  };
  return entry.entryKind === "subagent"
    ? { ...mapped, entryKind: "subagent", parentThreadId: (await resolveNativeReference(owners, { harness: entry.identity.harness, threadId: entry.parentThreadId }, projectId)).threadId } as WorkbenchThreadSidebarEntry
    : mapped;
}

async function mapThreadDisplayKey(
  owners: NativeTranscriptIdentityOwners, key: string, projectId: string | undefined, direction: "public" | "native",
): Promise<string> {
  const qualified = projectId ? null : parseProjectQualifiedThreadDisplayKey(key);
  if (qualified) return getProjectQualifiedThreadDisplayKey(qualified.projectId, await mapThreadDisplayKey(owners, qualified.threadKey, qualified.projectId, direction));
  const reference = /^(codex|copilot|opencode):(.+)$/u.exec(key);
  if (!reference) return key;
  const harness = WorkbenchHarnessSchema.parse(reference[1]);
  if (direction === "public") {
    return `${harness}:${(await resolveNativeReference(owners, { harness, threadId: reference[2]! }, projectId)).threadId}`;
  }
  const resolved = await mapWorkbenchProviderRequest(owners.threads, harness, { params: { threadId: reference[2]! } });
  return `${resolved.harness}:${(resolved.request.params as { threadId: string }).threadId}`;
}

async function mapNativeLayout(owners: NativeTranscriptIdentityOwners, layout: ThreadDisplayLayout, projectId?: string): Promise<ThreadDisplayLayout> {
  const key = (value: string) => mapThreadDisplayKey(owners, value, projectId, "public");
  const result: ThreadDisplayLayout = { ...layout };
  for (const section of ["pinned", "snoozed", "settled", "settledPinned"] as const) {
    if (!layout[section]) continue;
    result[section] = Object.fromEntries(await Promise.all(Object.entries(layout[section]).map(async ([id, position]) => [
      await key(id), { above: await Promise.all(position.above.map(key)), below: await Promise.all(position.below.map(key)) },
    ])));
  }
  if (layout.folders) result.folders = await Promise.all(layout.folders.map(async (folder) => ({
    ...folder, threadKeys: await Promise.all(folder.threadKeys.map(key)),
  })));
  return result;
}

async function mapNativeSidebar(owners: NativeTranscriptIdentityOwners, sidebar: WorkbenchThreadSidebarSnapshot): Promise<WorkbenchThreadSidebarSnapshot> {
  return {
    ...sidebar,
    entries: await Promise.all(sidebar.entries.map((entry) => mapNativeSidebarEntry(owners, sidebar.projectId, entry))),
    ...(sidebar.displayOrder ? { displayOrder: await mapNativeLayout(owners, sidebar.displayOrder, sidebar.projectId) } : {}),
  };
}

async function mapNativeProjectSummary(owners: NativeTranscriptIdentityOwners, summary: WorkbenchProjectThreadSummary): Promise<WorkbenchProjectThreadSummary> {
  return {
    ...summary,
    unsettledThreads: await Promise.all(summary.unsettledThreads.map(async (entry) => ({
      ...entry, identity: { ...entry.identity, threadId: (await resolveNativeReference(owners, entry.identity, summary.projectId)).threadId },
    }))),
    pinnedThreads: await Promise.all(summary.pinnedThreads.map(async (entry) => {
      if (entry.entryKind === "draft") return entry;
      const mapped = await mapNativeSidebarEntry(owners, summary.projectId, entry);
      if (mapped.entryKind !== "thread") throw new Error("Pinned thread projection changed its entry kind.");
      return { ...entry, identity: mapped.identity, lifecycle: mapped.lifecycle, gitArc: mapped.gitArc };
    })),
  };
}

export async function mapNativeThreadStateSnapshot(owners: NativeTranscriptIdentityOwners, snapshot: WorkbenchThreadStateSnapshot): Promise<WorkbenchThreadStateSnapshot> {
  if (!("updateKind" in snapshot)) return mapNativeSidebar(owners, snapshot);
  switch (snapshot.updateKind) {
    case "activity": return { ...snapshot,
      identity: { ...snapshot.identity, threadId: (await resolveNativeReference(owners, snapshot.identity, snapshot.projectId)).threadId },
      ...(snapshot.displayOrder ? { displayOrder: await mapNativeLayout(owners, snapshot.displayOrder, snapshot.projectId) } : {}),
    };
    case "projectThreadSidebar": return { ...snapshot, sidebar: await mapNativeSidebar(owners, snapshot.sidebar) };
    case "projectThreadSummary": return { ...snapshot, summary: await mapNativeProjectSummary(owners, snapshot.summary) };
    case "pinnedThreadLayout":
    case "homeThreadDisplayOrder": return { ...snapshot, displayOrder: await mapNativeLayout(owners, snapshot.displayOrder) };
    default: return snapshot;
  }
}

async function mapThreadTarget(owners: NativeTranscriptIdentityOwners, target: WorkbenchThreadTarget, projectId: string | undefined, direction: "public" | "native"): Promise<WorkbenchThreadTarget> {
  if (target.kind === "draft" || target.kind === "new") return target;
  const harness = target.harness ?? "codex";
  const map = async (threadId: string) => direction === "public"
    ? (await resolveNativeReference(owners, { harness, threadId }, projectId)).threadId
    : ((await mapWorkbenchProviderRequest(owners.threads, harness, { params: { threadId } })).request.params as { threadId: string }).threadId;
  return {
    ...target, threadId: await map(target.threadId),
    ...(target.kind === "subagent" ? { parentThreadId: await map(target.parentThreadId) } : {}),
  };
}

export async function mapNativeThreadStateResult(owners: NativeTranscriptIdentityOwners, value: unknown): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  let result = value as Record<string, unknown>;
  if ("sidebar" in result) {
    const opened = value as WorkbenchThreadStateOpenResult;
    result = { ...result, sidebar: await mapNativeSidebar(owners, opened.sidebar),
      ...(opened.projectThreads ? { projectThreads: { ...opened.projectThreads,
        projects: await Promise.all(opened.projectThreads.projects.map((summary) => mapNativeProjectSummary(owners, summary))),
      } } : {}),
    };
  }
  if ("projectSidebars" in result) {
    const opened = value as WorkbenchGlobalThreadStateOpenResult;
    result = { ...result, projectSidebars: { ...opened.projectSidebars,
      projects: await Promise.all(opened.projectSidebars.projects.map((sidebar) => mapNativeSidebar(owners, sidebar))),
    } };
  }
  for (const name of ["pinnedThreadLayout", "homeThreadDisplayOrder"] as const) {
    const layout = result[name] as { displayOrder: ThreadDisplayLayout } | undefined;
    if (layout) result = { ...result, [name]: { ...layout, displayOrder: await mapNativeLayout(owners, layout.displayOrder) } };
  }
  if ("context" in result) {
    const { context } = value as WorkbenchPinnedThreadContextResult;
    if (context) result = { ...result, context: {
      ...context, target: await mapThreadTarget(owners, context.target, context.projectId, "public"),
      entries: await Promise.all(context.entries.map((entry) => mapNativeSidebarEntry(owners, context.projectId, entry))),
    } };
  }
  if ("identity" in result) {
    const identity = result.identity as ThreadIdentity;
    result = { ...result, identity: { ...identity, threadId: (await resolveNativeReference(owners, identity)).threadId } };
  }
  return result;
}

export async function mapWorkbenchThreadStateRequest(owners: NativeTranscriptIdentityOwners, request: WorkbenchThreadStateRequest): Promise<WorkbenchThreadStateRequest> {
  const projectId = "projectId" in request ? request.projectId : undefined;
  let result = request;
  if ("identity" in request) {
    const mapped = await mapWorkbenchProviderRequest(owners.threads, request.identity.harness, {
      params: { threadId: request.identity.threadId, ...("turnId" in request ? { turnId: request.turnId } : {}) },
    });
    const native = mapped.request.params as { threadId: string; turnId?: string };
    result = { ...result, identity: { harness: mapped.harness, threadId: native.threadId },
      ...("turnId" in request ? { turnId: native.turnId } : {}),
    } as WorkbenchThreadStateRequest;
  }
  if (request.method === "workbench/thread-state/pin/open") {
    result = { ...request, target: await mapThreadTarget(owners, request.target, request.projectId, "native") };
  } else if (request.method === "workbench/thread-state/snooze/until") {
    const mapped = await mapWorkbenchProviderRequest(owners.threads, request.target.identity.harness, { params: { threadId: request.target.identity.threadId } });
    result = { ...result, target: { ...request.target,
      identity: { harness: mapped.harness, threadId: (mapped.request.params as { threadId: string }).threadId },
    } } as WorkbenchThreadStateRequest;
  }
  for (const field of ["sourceKey", "targetKey", "beforeKey", "destinationFolderKey"] as const) {
    if (field in request && typeof request[field as keyof typeof request] === "string") {
      const key = (request as Record<string, unknown>)[field] as string;
      result = { ...result, [field]: await mapThreadDisplayKey(owners, key, projectId, "native") };
    }
  }
  if (request.method === "workbench/thread-state/questionnaire/resolve") {
    const mapped = await mapWorkbenchProviderRequest(owners.threads, request.identity.harness, {
      params: { threadId: request.entry.threadId, turnId: request.entry.turnId },
    });
    const native = mapped.request.params as { threadId: string; turnId: string };
    result = { ...result, entry: { ...request.entry, ...native } } as WorkbenchThreadStateRequest;
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
    return owners.threads.knownNativeBinding(harness, params.threadId);
  };
  let mapped = { ...result };
  if (typeof result.threadId === "string") {
    mapped.threadId = owners.threads.workbenchIdForNative(owners.threads.knownNativeBinding(harness, result.threadId));
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
  if (result.turn) mapped.turn = mapProviderTurn(owners, native(), result.turn as Turn);
  if (typeof result.turnId === "string") {
    mapped.turnId = owners.threads.workbenchTurnIdForNative({ ...native(), nativeTurnId: result.turnId });
  }
  if (request.method === "thread/context/read" || request.method === WORKBENCH_THREAD_PAGE_READ_METHOD) {
    const context = result as unknown as WorkbenchThreadContextReadResponse;
    const binding = native();
    const mapTurn = (nativeTurnId: string) => owners.threads.workbenchTurnIdForNative({ ...binding, nativeTurnId });
    mapped = {
      ...mapped,
      questionnaireEntries: await Promise.all(context.questionnaireEntries.map((entry) => (
        mapNativeQuestionnaireHistory(owners, { harness, threadId: binding.nativeThreadId }, entry)
      ))),
      steerEntries: context.steerEntries.map((entry) => {
        const fact = mapNativeTranscriptObservation(owners, binding, { kind: "steer", entry, observedAt: entry.resolvedAt ?? entry.attemptedAt });
        if (fact.kind !== "steer") throw new Error("Steer mapping changed its kind.");
        return fact.entry;
      }),
      browseResultEntries: context.browseResultEntries.map((entry) => {
        const fact = mapNativeTranscriptObservation(owners, binding, { kind: "browse", entry });
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
    threadId: params.threadId.trim(), harness,
    ...(typeof params.projectId === "string" ? { projectId: params.projectId } : {}),
  });
  if (!thread) throw new Error("Workbench thread identity has not been observed.");
  const turnFields = request.method === WORKBENCH_THREAD_PAGE_READ_METHOD
    ? ["cursor", "turnId", "expectedTurnId"] : ["turnId", "expectedTurnId"];
  const turns = await Promise.all(turnFields.flatMap((field) => {
    const reference = params[field];
    if (typeof reference !== "string" || !reference.trim()) return [];
    return [(async () => {
      const turn = await threads.resolveTurn({ threadId: thread.threadId, turnId: reference.trim() });
      if (!turn) throw new Error("Requested turn does not belong to the Workbench thread.");
      if (turn.native.nativeTurnId === null) throw new Error("Requested Workbench turn has no native execution.");
      return { field, turn };
    })()];
  }));
  const requestedTurnIds = request.method === "workbench/transcript/materialize" && Array.isArray(params.turnIds)
    ? await Promise.all(params.turnIds.map(async (turnId) => {
      if (typeof turnId !== "string") throw new Error("Transcript turn references must be strings.");
      const turn = await threads.resolveTurn({ threadId: thread.threadId, turnId });
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
