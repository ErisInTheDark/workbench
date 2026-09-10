/*
 * Exports:
 * - CodexTranscriptProviderContext: Workbench identity and timestamps attached to provider transcript facts.
 * - createCodexTranscriptProviderThreadObservation: project one provider thread into its atomic Workbench metadata fact.
 * - createCodexTranscriptProviderTurnObservation: project one provider turn into its atomic Workbench lifecycle fact.
 * - createCodexTranscriptProviderItemObservation: project one provider item lifecycle without reading storage.
 * - createCodexTranscriptProviderDynamicToolObservation: project one provider dynamic-tool request without reading storage.
 * - createCodexTranscriptProviderTurnScopeObservation: project one complete provider turn into a replacement boundary.
 * - createCodexTranscriptProviderThreadObservations: project one complete provider thread response into ordered atomic facts.
 * - createCodexTranscriptProviderThreadScopeObservation: project complete turns from one provider thread response into a replacement boundary.
 * - createCodexTurnUsageContextObservation: project observed turn pricing context.
 * - createCodexTurnTokenUsageObservation: project cumulative token counts.
 * - createCodexTurnTokenUsageObservationFromNotification: decode native token notifications.
 * - readCodexUsageContext: decode resolved or overridden model settings.
 * - createCodexModelRerouteObservation: retain explicit mixed-model evidence.
 * - createCodexUsageImport: project retained usage journals without transcript bodies.
 */
import type { JsonValue } from "workbench-shared/codex/generated/app-server/serde_json/JsonValue";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { TokenUsageBreakdown } from "workbench-shared/codex/generated/app-server/v2/TokenUsageBreakdown";
import type {
  NativeTranscriptAtomicObservation,
  WorkbenchTranscriptItemLifecycle,
  WorkbenchTranscriptProviderTurnScopeObservation,
  NativeTranscriptObservation,
} from "./database/transcript/workbench-transcript-types.ts";
import type { CodexTranscriptRawEvent, CodexTranscriptTurnIndexEntry } from "./codex-transcript-types.ts";
import { normalizeThreadItems } from "workbench-shared/codex/thread-item-normalization";
import { getCodexItemIdentityKind } from "workbench-shared/codex/thread-item-source";
import { withWorkbenchThreadItemIdentity } from "workbench-shared/workbench/thread/thread-item-identity";
import type { JsonRpcNotification, JsonRpcRequest } from "./bridge-types.ts";
import { WORKBENCH_STATS_USAGE_DATA_VERSION } from "workbench-shared/workbench/stats/workbench-stats-usage";
import { createFirstTurnItemOwners } from "./codex-transcript-item-ownership.ts";
import { mergeThreadItem } from "./codex-transcript-item-merge.ts";
import { asRecord, asString } from "./codex-transcript-normalizers.ts";
import { createDynamicToolCallItem } from "./codex-transcript-timeline.ts";
import { NativeThreadIdSchema, NativeTurnIdSchema, type NativeThreadId, type NativeTurnId, type ProjectId } from "workbench-shared/workbench/identity";

export interface CodexTranscriptProviderContext {
  activityAt: number;
  createdAt: number;
  nativeLocation: string;
  projectId: ProjectId;
  projectRoot: string;
  title: string;
  updatedAt: number;
}

export function createCodexTurnUsageContextObservation(input: {
  modelChanged?: boolean;
  model: string | null;
  observedAt: number;
  serviceTier: string | null;
  threadId: string;
  turnId: string;
}): Extract<NativeTranscriptAtomicObservation, { kind: "turnUsageContext" }> {
  return { kind: "turnUsageContext", ...input, threadId: NativeThreadIdSchema.parse(input.threadId), turnId: NativeTurnIdSchema.parse(input.turnId) };
}

export function readCodexUsageContext(value: unknown) {
  const record = asRecord(value);
  const model = asString(asRecord(asRecord(record?.collaborationMode)?.settings)?.model)?.trim()
    || asString(record?.model)?.trim() || null;
  const tier = asString(record?.serviceTier)?.trim();
  return { model, serviceTier: tier && ["fast", "priority", "standard"].includes(tier) ? tier : null };
}

export function createCodexModelRerouteObservation(notification: JsonRpcNotification, observedAt: number) {
  if (notification.method !== "model/rerouted") return null;
  const params = asRecord(notification.params);
  const threadId = asString(params?.threadId);
  const turnId = asString(params?.turnId);
  const fromModel = asString(params?.fromModel)?.trim();
  const model = asString(params?.toModel)?.trim();
  if (!threadId || !turnId || !model || !fromModel) throw new Error("Codex model reroute has incomplete usage ownership");
  return createCodexTurnUsageContextObservation({
    model, modelChanged: model !== fromModel, serviceTier: null, observedAt, threadId, turnId,
  });
}

export function createCodexUsageImport(input: {
  context: CodexTranscriptProviderContext;
  thread: Thread;
  turnIndex: readonly CodexTranscriptTurnIndexEntry[];
  events: readonly CodexTranscriptRawEvent[];
}): Extract<NativeTranscriptObservation, { kind: "usageWindow" }> {
  const threadId = NativeThreadIdSchema.parse(input.thread.id);
  const catalog: Extract<NativeTranscriptAtomicObservation, { kind: "thread" | "turn" }>[] = [
    createCodexTranscriptProviderThreadObservation(threadId, input.context),
    ...input.turnIndex.map((turn, turnIndex): Extract<NativeTranscriptAtomicObservation, { kind: "turn" }> => ({
      kind: "turn", threadId, turnId: NativeTurnIdSchema.parse(turn.turnId), turnIndex, harnessId: "codex",
      nativeLocation: input.context.nativeLocation, nativeThreadId: threadId, nativeTurnId: NativeTurnIdSchema.parse(turn.turnId),
      state: turn.status ?? "admitted", createdAt: Math.round((turn.startedAt ?? input.thread.createdAt) * 1_000),
      startedAt: secondsToMilliseconds(turn.startedAt), endedAt: secondsToMilliseconds(turn.completedAt), durationMs: null,
    })),
  ];
  const turns = new Set(input.turnIndex.map(({ turnId }) => turnId));
  const observations: Extract<NativeTranscriptAtomicObservation, { kind: "turnUsageContext" | "turnTokenUsage" }>[] = [];
  let context: ReturnType<typeof readCodexUsageContext> | null = null;
  let activeTurnId: string | null = null;
  for (const event of [...input.events].sort((left, right) => left.receivedAt - right.receivedAt)) {
    const notification = event.payload as JsonRpcNotification;
    const params = asRecord(notification.params);
    if (asString(params?.threadId) !== threadId) throw new Error("Retained usage event crossed thread ownership");
    if (event.method === "thread/settings/updated") {
      const previous = context;
      context = readCodexUsageContext(params?.threadSettings);
      if (activeTurnId && (context.model !== previous?.model || context.serviceTier !== previous?.serviceTier)) {
        observations.push(createCodexTurnUsageContextObservation({
          ...context, observedAt: event.receivedAt, threadId, turnId: activeTurnId,
          modelChanged: Boolean(previous?.model && context.model && previous.model !== context.model),
        }));
      }
      continue;
    }
    if (event.method === "turn/started") {
      const turnId = asString(asRecord(params?.turn)?.id);
      if (!turnId || !turns.has(turnId)) throw new Error("Retained usage start references an unknown catalog turn");
      activeTurnId = turnId;
      if (context?.model) {
        observations.push(createCodexTurnUsageContextObservation({ ...context, observedAt: event.receivedAt, threadId, turnId }));
      }
      continue;
    }
    if (event.method === "turn/completed") {
      if (asString(asRecord(params?.turn)?.id) === activeTurnId) activeTurnId = null;
      continue;
    }
    const observation = createCodexModelRerouteObservation(notification, event.receivedAt)
      ?? createCodexTurnTokenUsageObservationFromNotification(notification, event.receivedAt);
    if (observation) {
      if (!turns.has(observation.turnId)) throw new Error("Retained usage event references an unknown catalog turn");
      observations.push(observation);
    }
  }
  return { kind: "usageWindow", threadId, catalog, observations };
}

export function createCodexTurnTokenUsageObservation(input: {
  observedAt: number;
  threadId: string;
  turnId: string;
  usage: TokenUsageBreakdown;
}): Extract<NativeTranscriptAtomicObservation, { kind: "turnTokenUsage" }> {
  return {
    cumulative: {
      cacheWriteInputTokens: input.usage.cacheWriteInputTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      reasoningOutputTokens: input.usage.reasoningOutputTokens,
      totalTokens: input.usage.totalTokens,
    },
    kind: "turnTokenUsage",
    observedAt: input.observedAt,
    threadId: NativeThreadIdSchema.parse(input.threadId),
    turnId: NativeTurnIdSchema.parse(input.turnId),
    usageDataVersion: WORKBENCH_STATS_USAGE_DATA_VERSION,
  };
}

export function createCodexTurnTokenUsageObservationFromNotification(
  notification: JsonRpcNotification,
  observedAt: number,
) {
  if (notification.method !== "thread/tokenUsage/updated") return null;
  const params = asRecord(notification.params);
  const threadId = asString(params?.threadId)?.trim();
  const turnId = asString(params?.turnId)?.trim();
  const total = asRecord(asRecord(params?.tokenUsage)?.total);
  if (!threadId || !turnId || !total) return null;
  const number = (name: string) => typeof total[name] === "number" && Number.isFinite(total[name])
    ? Math.max(0, total[name])
    : 0;
  return createCodexTurnTokenUsageObservation({
    observedAt,
    threadId,
    turnId,
    usage: {
      cacheWriteInputTokens: number("cacheWriteInputTokens"),
      cachedInputTokens: number("cachedInputTokens"),
      inputTokens: number("inputTokens"),
      outputTokens: number("outputTokens"),
      reasoningOutputTokens: number("reasoningOutputTokens"),
      totalTokens: number("totalTokens"),
    },
  });
}

function secondsToMilliseconds(value: number | null) {
  return value === null ? null : Math.round(value * 1_000);
}

function normalizeProviderTurn(turn: Turn): Turn {
  return {
    ...turn,
    items: normalizeThreadItems(turn.items, { mergeDuplicateItems: mergeThreadItem, classifyItem: getCodexItemIdentityKind }),
  };
}

export function createCodexTranscriptProviderThreadObservation(
  threadId: string,
  context: CodexTranscriptProviderContext,
): Extract<NativeTranscriptAtomicObservation, { kind: "thread" }> {
  return {
    activityAt: context.activityAt,
    createdAt: context.createdAt,
    kind: "thread",
    projectId: context.projectId,
    projectRoot: context.projectRoot,
    threadId: NativeThreadIdSchema.parse(threadId),
    title: context.title,
    updatedAt: context.updatedAt,
  };
}

export function createCodexTranscriptProviderTurnObservation({
  context,
  threadId,
  turn,
  turnIndex,
}: {
  context: CodexTranscriptProviderContext;
  threadId: string;
  turn: Turn;
  turnIndex?: number;
}): Extract<NativeTranscriptAtomicObservation, { kind: "turn" }> {
  const startedAt = secondsToMilliseconds(turn.startedAt);
  return {
    createdAt: startedAt ?? context.createdAt,
    durationMs: turn.durationMs,
    endedAt: secondsToMilliseconds(turn.completedAt),
    harnessId: "codex",
    kind: "turn",
    nativeLocation: context.nativeLocation,
    nativeThreadId: NativeThreadIdSchema.parse(threadId),
    nativeTurnId: NativeTurnIdSchema.parse(turn.id),
    startedAt,
    state: turn.status,
    threadId: NativeThreadIdSchema.parse(threadId),
    turnId: NativeTurnIdSchema.parse(turn.id),
    ...(turnIndex === undefined ? {} : { turnIndex }),
  };
}

export function createCodexTranscriptProviderItemObservation({
  completedAtMs,
  item,
  lifecycle,
  observedAt,
  startedAtMs,
  threadId,
  turnId,
}: {
  completedAtMs?: number | null;
  item: ThreadItem;
  lifecycle: WorkbenchTranscriptItemLifecycle;
  observedAt: number;
  startedAtMs?: number | null;
  threadId: string;
  turnId: string;
}): Extract<NativeTranscriptAtomicObservation, { kind: "item" }> {
  const hasTimeline = startedAtMs !== undefined || completedAtMs !== undefined;
  return {
    item: withWorkbenchThreadItemIdentity(item, getCodexItemIdentityKind(item)),
    kind: "item",
    lifecycle,
    observedAt,
    ...(hasTimeline ? {
      timeline: {
        completedAt: completedAtMs ?? null,
        firstSeenAt: startedAtMs ?? completedAtMs ?? observedAt,
        itemId: item.id,
        lastSeenAt: completedAtMs ?? startedAtMs ?? observedAt,
        startedAt: startedAtMs ?? null,
      },
    } : {}),
    threadId: NativeThreadIdSchema.parse(threadId),
    turnId: NativeTurnIdSchema.parse(turnId),
  };
}

export function createCodexTranscriptProviderDynamicToolObservation(
  request: JsonRpcRequest,
  observedAt: number,
): Extract<NativeTranscriptAtomicObservation, { kind: "item" }> | null {
  if (request.method !== "item/tool/call") return null;
  const params = asRecord(request.params);
  const threadId = asString(params?.threadId);
  const turnId = asString(params?.turnId);
  const callId = asString(params?.callId);
  const tool = asString(params?.tool);
  if (!threadId || !turnId || !callId || !tool) return null;
  return createCodexTranscriptProviderItemObservation({
    item: createDynamicToolCallItem({
      arguments: (params?.arguments ?? null) as JsonValue,
      callId,
      namespace: asString(params?.namespace),
      threadId,
      tool,
      turnId,
    }),
    lifecycle: "streaming",
    observedAt,
    startedAtMs: observedAt,
    threadId,
    turnId,
  });
}

export function createCodexTranscriptProviderThreadObservations(
  thread: Thread,
  context: CodexTranscriptProviderContext,
): NativeTranscriptAtomicObservation[] {
  const turns = thread.turns.map(normalizeProviderTurn);
  const itemOwners = createFirstTurnItemOwners(turns.map((turn) => ({
    itemIds: turn.items.map(({ id }) => id),
    turnId: turn.id,
  })));
  const observations: NativeTranscriptAtomicObservation[] = [
    createCodexTranscriptProviderThreadObservation(thread.id, context),
  ];
  for (const [turnIndex, turn] of turns.entries()) {
    observations.push(createCodexTranscriptProviderTurnObservation({
      context,
      threadId: thread.id,
      turn,
      turnIndex,
    }));
    for (const item of turn.items) {
      if (itemOwners.get(item.id) !== turn.id) continue;
      observations.push(createCodexTranscriptProviderItemObservation({
        item,
        lifecycle: turn.status === "inProgress" ? "streaming" : "completed",
        observedAt: Math.round((turn.completedAt ?? turn.startedAt ?? thread.updatedAt) * 1_000),
        threadId: thread.id,
        turnId: turn.id,
      }));
    }
  }
  return observations;
}

export function createCodexTranscriptProviderTurnScopeObservation({
  context,
  threadId,
  turn,
  turnIndex,
}: {
  context: CodexTranscriptProviderContext;
  threadId: string;
  turn: Turn;
  turnIndex?: number;
}): WorkbenchTranscriptProviderTurnScopeObservation<NativeThreadId, NativeTurnId> {
  const normalizedTurn = normalizeProviderTurn(turn);
  return {
    completeTurnIds: [NativeTurnIdSchema.parse(normalizedTurn.id)],
    kind: "providerTurnScope",
    observations: [
      createCodexTranscriptProviderTurnObservation({
        context,
        threadId,
        turn: normalizedTurn,
        turnIndex,
      }),
      ...normalizedTurn.items.map((item) => createCodexTranscriptProviderItemObservation({
        item,
        lifecycle: normalizedTurn.status === "inProgress" ? "streaming" : "completed",
        observedAt: Math.round(
          (normalizedTurn.completedAt ?? normalizedTurn.startedAt ?? context.updatedAt / 1_000) * 1_000,
        ),
        threadId,
        turnId: normalizedTurn.id,
      })),
    ],
    threadId: NativeThreadIdSchema.parse(threadId),
  };
}

export function createCodexTranscriptProviderThreadScopeObservation(
  thread: Thread,
  context: CodexTranscriptProviderContext,
): WorkbenchTranscriptProviderTurnScopeObservation<NativeThreadId, NativeTurnId> {
  const completeTurnIds = thread.turns
    .filter(({ itemsView }) => itemsView === "full")
    .map(({ id }) => NativeTurnIdSchema.parse(id));
  const completeTurnIdSet = new Set(completeTurnIds);
  return {
    completeTurnIds,
    kind: "providerTurnScope",
    observations: createCodexTranscriptProviderThreadObservations({
      ...thread,
      turns: thread.turns.map((turn) => (
        completeTurnIdSet.has(NativeTurnIdSchema.parse(turn.id)) ? turn : { ...turn, items: [] }
      )),
    }, context),
    threadId: NativeThreadIdSchema.parse(thread.id),
  };
}
