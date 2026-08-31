/*
 * CodexTranscriptProviderContext: Workbench identity and timestamps attached to provider transcript facts. Keywords: codex, transcript, provider, context.
 * createCodexTranscriptProviderThreadObservation: project one provider thread into its atomic Workbench metadata fact. Keywords: codex, transcript, provider, thread.
 * createCodexTranscriptProviderTurnObservation: project one provider turn into its atomic Workbench lifecycle fact. Keywords: codex, transcript, provider, turn.
 * createCodexTranscriptProviderItemObservation: project one provider item lifecycle without reading storage. Keywords: codex, transcript, provider, item.
 * createCodexTranscriptProviderDynamicToolObservation: project one provider dynamic-tool request without reading storage. Keywords: codex, transcript, provider, tool.
 * createCodexTranscriptProviderThreadObservations: project one complete provider thread response into ordered atomic facts. Keywords: codex, transcript, provider, snapshot.
 */
import type { JsonValue } from "../lib/codex/generated/app-server/serde_json/JsonValue.ts";
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread.ts";
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem.ts";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn.ts";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptItemLifecycle,
} from "./database/transcript/workbench-transcript-types.ts";
import type { JsonRpcRequest } from "./bridge-types.ts";
import { createFirstTurnItemOwners } from "./codex-transcript-item-ownership.ts";
import { asRecord, asString } from "./codex-transcript-normalizers.ts";
import { createDynamicToolCallItem } from "./codex-transcript-timeline.ts";

export interface CodexTranscriptProviderContext {
  activityAt: number;
  createdAt: number;
  nativeLocation: string;
  projectId: string;
  projectRoot: string;
  title: string;
  updatedAt: number;
}

function secondsToMilliseconds(value: number | null) {
  return value === null ? null : Math.round(value * 1_000);
}

export function createCodexTranscriptProviderThreadObservation(
  threadId: string,
  context: CodexTranscriptProviderContext,
): Extract<WorkbenchTranscriptAtomicObservation, { kind: "thread" }> {
  return {
    activityAt: context.activityAt,
    createdAt: context.createdAt,
    kind: "thread",
    projectId: context.projectId,
    projectRoot: context.projectRoot,
    threadId,
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
}): Extract<WorkbenchTranscriptAtomicObservation, { kind: "turn" }> {
  const startedAt = secondsToMilliseconds(turn.startedAt);
  return {
    createdAt: startedAt ?? context.createdAt,
    durationMs: turn.durationMs,
    endedAt: secondsToMilliseconds(turn.completedAt),
    harnessId: "codex",
    kind: "turn",
    nativeLocation: context.nativeLocation,
    nativeThreadId: threadId,
    nativeTurnId: turn.id,
    startedAt,
    state: turn.status,
    threadId,
    turnId: turn.id,
    ...(turnIndex === undefined ? {} : { turnIndex }),
  };
}

export function createCodexTranscriptProviderItemObservation({
  item,
  lifecycle,
  observedAt,
  threadId,
  turnId,
}: {
  item: ThreadItem;
  lifecycle: WorkbenchTranscriptItemLifecycle;
  observedAt: number;
  threadId: string;
  turnId: string;
}): Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }> {
  return {
    item,
    kind: "item",
    lifecycle,
    observedAt,
    threadId,
    turnId,
  };
}

export function createCodexTranscriptProviderDynamicToolObservation(
  request: JsonRpcRequest,
  observedAt: number,
): Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }> | null {
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
    threadId,
    turnId,
  });
}

export function createCodexTranscriptProviderThreadObservations(
  thread: Thread,
  context: CodexTranscriptProviderContext,
): WorkbenchTranscriptAtomicObservation[] {
  const itemOwners = createFirstTurnItemOwners(thread.turns.map((turn) => ({
    itemIds: turn.items.map(({ id }) => id),
    turnId: turn.id,
  })));
  const observations: WorkbenchTranscriptAtomicObservation[] = [
    createCodexTranscriptProviderThreadObservation(thread.id, context),
  ];
  for (const [turnIndex, turn] of thread.turns.entries()) {
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
