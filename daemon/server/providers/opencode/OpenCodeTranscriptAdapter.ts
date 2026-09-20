/*
 * Exports:
 * - OpenCodeTranscriptOwners: shared identity and recorder ports used by the provider edge.
 * - openCodeToolContentItems: preserve provider tool content or its bounded structured failure.
 * - default OpenCodeTranscriptAdapter: translate canonical OpenCode sessions/messages into ordered WB transcript facts.
 */
import type {
  SessionInfo, SessionMessageAssistant, SessionMessageInfo, SessionMessageUser,
} from "@opencode/client";
import { z } from "zod";
import {
  NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema,
  type WorkbenchThreadId, WorkbenchThreadIdSchema, type WorkbenchTurnId, WorkbenchItemIdSchema,
} from "workbench-shared/workbench/identity";
import {
  WorkbenchUserInputSchema, type WorkbenchUserInput,
} from "workbench-shared/workbench/provider/provider-input";
import type { TranscriptTextField } from "workbench-shared/workbench/transcript/thread-transcript-stream";
import type {
  DynamicToolCallOutputContentItem, ThreadItem,
} from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import type WorkbenchThreadIdentityController from "../../WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "../../WorkbenchTranscriptIdentityController";
import type { WorkbenchTranscriptItemLifecycle } from "../../database/transcript/workbench-transcript-types";
import type { WorkbenchTranscriptAtomicObservation } from "../../database/transcript/workbench-transcript-types";
import type { DaemonTranscriptRegistration } from "../../daemon-runtime-objects";
import { WORKBENCH_STATS_USAGE_DATA_VERSION } from "workbench-shared/workbench/stats/workbench-stats-usage";
import {
  openCodeContentSource, openCodeItemSource, type OpenCodeTranscriptSource,
} from "./open-code-source-id";

export interface OpenCodeTranscriptOwners {
  threads: Pick<WorkbenchThreadIdentityController, "observe" | "observeTurns">;
  items: Pick<WorkbenchTranscriptIdentityController, "admit" | "itemIdForSource">;
  transcript: Pick<DaemonTranscriptRegistration, "acceptLiveUpdate" | "record">;
  modelContext?(model: { id: string; providerID: string }, directory: string): Promise<number | null>;
}

interface MessageTurn {
  nativeTurnId: string;
  messages: SessionMessageInfo[];
}

interface OpenCodeTurnScope {
  harnessId: "opencode";
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
  turnIndex: number;
  nativeThreadId: ReturnType<typeof NativeThreadIdSchema.parse>;
  nativeTurnId: ReturnType<typeof NativeTurnIdSchema.parse>;
  nativeLocation: string;
  createdAt: number;
  startedAt: number;
}

const workbenchMessageMetadataSchema = z.object({
  version: z.literal(1),
  delivery: z.enum(["queue", "steer"]),
  itemId: WorkbenchItemIdSchema,
  clientMessageId: z.string().min(1),
  input: z.array(WorkbenchUserInputSchema),
});
type WorkbenchMessageMetadata = z.infer<typeof workbenchMessageMetadataSchema>;
type OpenCodeSteerEntry = Omit<WorkbenchSteerHistoryEntry, "threadId" | "turnId"> & {
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
};

function workbenchMetadata(message: SessionMessageInfo): WorkbenchMessageMetadata | null {
  if (message.type !== "user") return null;
  const metadata = message.metadata?.workbench;
  const parsed = workbenchMessageMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

function steerInput(inputs: readonly WorkbenchUserInput[]): WorkbenchSteerHistoryEntry["input"] {
  return inputs.map((input) => {
    if (input.type !== "text") return { ...input };
    return {
      ...input,
      text_elements: input.text_elements.map(element => ({
        ...element,
        placeholder: element.placeholder ?? "",
      })),
    };
  });
}

function tokenBreakdown(tokens: NonNullable<SessionMessageAssistant["tokens"]>) {
  const inputTokens = tokens.input + tokens.cache.read + tokens.cache.write;
  return {
    cacheWriteInputTokens: tokens.cache.write,
    cachedInputTokens: tokens.cache.read,
    inputTokens,
    outputTokens: tokens.output,
    reasoningOutputTokens: tokens.reasoning,
    totalTokens: inputTokens + tokens.output + tokens.reasoning,
  };
}

function groupTurns(messages: readonly SessionMessageInfo[]) {
  const turns: MessageTurn[] = [];
  for (const message of messages) {
    const isSteer = workbenchMetadata(message)?.delivery === "steer";
    if ((message.type === "user" && !isSteer) || !turns.length) {
      turns.push({ nativeTurnId: message.id, messages: [message] });
    } else {
      turns.at(-1)!.messages.push(message);
    }
  }
  return turns;
}

interface OpenCodeMessageItem {
  kind: "item";
  item: ThreadItem;
  preferredItemId: string | null;
  source: OpenCodeTranscriptSource;
}

interface OpenCodeSteerItem {
  kind: "steer";
  metadata: WorkbenchMessageMetadata;
  observedAt: number;
  source: OpenCodeTranscriptSource;
}

type OpenCodeTranslatedItem = OpenCodeMessageItem | OpenCodeSteerItem;

export function openCodeToolContentItems(content: readonly {
  type: string;
  text?: string;
  uri?: string;
}[] | undefined, error?: { message: string }): DynamicToolCallOutputContentItem[] | null {
  const items: DynamicToolCallOutputContentItem[] = [];
  for (const part of content ?? []) {
    if (part.type === "text" && part.text !== undefined) {
      items.push({ type: "inputText", text: part.text });
    }
    if (part.type === "image" && part.uri !== undefined) {
      items.push({ type: "inputImage", imageUrl: part.uri });
    }
  }
  if (items.length) return items;
  return error ? [{ type: "inputText", text: error.message.slice(0, 1000) }] : null;
}

function messageItems(message: SessionMessageInfo): OpenCodeTranslatedItem[] {
  if (message.type === "user") {
    const user = message as SessionMessageUser;
    const metadata = workbenchMetadata(user);
    if (metadata?.delivery === "steer") {
      return [{
        kind: "steer",
        metadata,
        observedAt: user.time.created,
        source: openCodeItemSource(user.id),
      }];
    }
    return [{
      kind: "item",
      source: openCodeItemSource(user.id),
      preferredItemId: metadata?.itemId ?? null,
      item: {
        type: "userMessage", id: user.id, clientId: metadata?.clientMessageId ?? user.id,
        content: [{ type: "text", text: user.text, text_elements: [] }],
      },
    }];
  }
  if (message.type === "compaction") {
    return [{
      kind: "item",
      source: openCodeItemSource(message.id),
      preferredItemId: null,
      item: { type: "contextCompaction", id: message.id },
    }];
  }
  if (message.type !== "assistant") return [];
  const assistant = message as SessionMessageAssistant;
  let reasoningOrdinal = 0;
  let textOrdinal = 0;
  return assistant.content.flatMap((part): OpenCodeMessageItem[] => {
    if (part.type === "text") {
      return [{
        kind: "item",
        source: openCodeContentSource(assistant.id, "text", textOrdinal++),
        preferredItemId: null,
        item: {
          type: "agentMessage", id: assistant.id, text: part.text, phase: null,
          memoryCitation: null, delivery: null, questions: null,
        },
      }];
    }
    if (part.type === "reasoning") {
      return [{
        kind: "item",
        source: openCodeContentSource(assistant.id, "reasoning", reasoningOrdinal++),
        preferredItemId: null,
        item: { type: "reasoning", id: assistant.id, summary: [], content: [part.text] },
      }];
    }
    const state = part.state;
    const failed = state.status === "error"
      || state.status === "completed" && state.metadata?.error === true;
    return [{
      kind: "item",
      source: openCodeItemSource(part.id),
      preferredItemId: null,
      item: {
        type: "dynamicToolCall", id: part.id, namespace: "opencode", tool: part.name,
        arguments: state.input, status: failed ? "failed"
          : state.status === "completed" ? "completed" : "inProgress",
        contentItems: state.status === "completed" || state.status === "error"
          ? openCodeToolContentItems(state.content, state.status === "error" ? state.error : undefined)
          : null,
        success: failed ? false : state.status === "completed" ? true : null,
        durationMs: part.time.completed && part.time.ran ? part.time.completed - part.time.ran : null,
      },
    }];
  });
}

export default class OpenCodeTranscriptAdapter {
  private readonly turnScopes = new Map<string, OpenCodeTurnScope>();

  constructor(private readonly owners: OpenCodeTranscriptOwners) {}

  async recordItem(input: {
    threadId: WorkbenchThreadId;
    turnId: WorkbenchTurnId;
    source: OpenCodeTranscriptSource;
    item: ThreadItem;
    lifecycle: WorkbenchTranscriptItemLifecycle;
    observedAt: number;
  }) {
    const [identity] = await this.owners.items.admit([{
      threadId: input.threadId,
      sources: [{ turnId: input.turnId, kind: "stable", ...input.source }],
    }]);
    const itemId = identity!.itemId;
    await this.owners.transcript.record([{
      kind: "item",
      threadId: input.threadId,
      turnId: input.turnId,
      publicItemId: itemId,
      item: { ...input.item, id: itemId },
      lifecycle: input.lifecycle,
      observedAt: input.observedAt,
    }], { source: "provider" });
    return itemId;
  }

  async recordSteer(entry: OpenCodeSteerEntry) {
    await this.owners.transcript.record([{
      kind: "steer",
      entry,
      publicItemId: WorkbenchItemIdSchema.parse(entry.itemId),
      observedAt: entry.resolvedAt ?? entry.attemptedAt,
    }], { source: "workbench" });
  }

  async recordTurnState(input: {
    threadId: WorkbenchThreadId;
    turnId: WorkbenchTurnId;
    state: "inProgress" | "completed" | "interrupted" | "failed";
    observedAt: number;
  }) {
    const scope = this.turnScopes.get(`${input.threadId}:${input.turnId}`);
    if (!scope) throw new Error("OpenCode turn state has no admitted transcript scope.");
    const terminal = input.state !== "inProgress";
    await this.owners.transcript.record([{
      kind: "turn",
      ...scope,
      state: input.state,
      endedAt: terminal ? input.observedAt : null,
      durationMs: terminal ? Math.max(0, input.observedAt - scope.startedAt) : null,
    }], { source: "provider" });
  }

  appendText(input: {
    threadId: WorkbenchThreadId;
    turnId: WorkbenchTurnId;
    source: OpenCodeTranscriptSource;
    field: TranscriptTextField;
    index: number | null;
    text: string;
  }) {
    const itemId = this.owners.items.itemIdForSource(input.threadId, {
      turnId: input.turnId,
      kind: "stable",
      ...input.source,
    });
    this.owners.transcript.acceptLiveUpdate?.({
      kind: "text",
      threadId: input.threadId,
      turnId: input.turnId,
      itemId,
      field: input.field,
      index: input.index,
      text: input.text,
      append: true,
    });
  }

  async record(
    session: SessionInfo,
    messages: readonly SessionMessageInfo[],
    project: { id: string; rootPath: string },
    options: { keepLatestTurnOpen?: boolean; settleUsage?: boolean } = {},
  ) {
    const nativeThreadId = NativeThreadIdSchema.parse(session.id);
    const nativeLocation = session.location.directory;
    const identity = await this.owners.threads.observe({
      native: { harness: "opencode", nativeLocation, nativeThreadId },
      projectId: ProjectIdSchema.parse(project.id),
      projectRoot: project.rootPath,
      title: session.title ?? "New thread",
      createdAt: session.time.created,
      updatedAt: session.time.updated,
      activityAt: session.time.updated,
    });
    const groups = groupTurns(messages);
    const turns = await this.owners.threads.observeTurns(groups.map((group, index) => {
      const first = group.messages[0]!;
      const last = group.messages.at(-1)!;
      const assistant = [...group.messages].reverse().find(message => message.type === "assistant") as SessionMessageAssistant | undefined;
      const latestSteerIndex = group.messages.findLastIndex(message => workbenchMetadata(message)?.delivery === "steer");
      const latestAssistantIndex = group.messages.findLastIndex(message => message.type === "assistant");
      const keepOpen = index === groups.length - 1
        && (options.keepLatestTurnOpen || latestSteerIndex > latestAssistantIndex);
      const completedAt = keepOpen
        ? null
        : assistant?.time.completed ?? (index < groups.length - 1 ? last.time.created : null);
      return {
        kind: "turn" as const,
        threadId: identity.threadId,
        turnId: NativeTurnIdSchema.parse(group.nativeTurnId),
        nativeTurnId: NativeTurnIdSchema.parse(group.nativeTurnId),
        nativeThreadId,
        nativeLocation,
        harnessId: "opencode",
        state: completedAt === null ? "inProgress" as const : assistant?.error ? "failed" as const : "completed" as const,
        createdAt: first.time.created,
        startedAt: first.time.created,
        endedAt: completedAt,
        durationMs: completedAt === null ? null : Math.max(0, completedAt - first.time.created),
      };
    }));
    for (const [index, turn] of turns.entries()) {
      const first = groups[index]!.messages[0]!;
      this.turnScopes.set(`${turn.threadId}:${turn.turnId}`, {
        harnessId: "opencode",
        threadId: turn.threadId,
        turnId: turn.turnId,
        turnIndex: turn.turnIndex,
        nativeThreadId,
        nativeTurnId: NativeTurnIdSchema.parse(groups[index]!.nativeTurnId),
        nativeLocation,
        createdAt: first.time.created,
        startedAt: first.time.created,
      });
    }
    const translated = groups.map((group, groupIndex) => group.messages.flatMap(message => (
      messageItems(message).map(entry => ({
        ...entry, message, turnId: turns[groupIndex]!.turnId,
      }))
    )));
    const flatTranslated = translated.flat();
    const itemIdentities = await this.owners.items.admit(flatTranslated.map((entry) => ({
      threadId: identity.threadId,
      ...(entry.kind === "steer"
        ? { itemId: entry.metadata.itemId }
        : entry.preferredItemId ? { itemId: WorkbenchItemIdSchema.parse(entry.preferredItemId) } : {}),
      sources: [{ turnId: entry.turnId, kind: "stable" as const, ...entry.source }],
    })));
    let itemIndex = 0;
    const publicTranslated = translated.map(entries => entries.map(entry => ({
      ...entry,
      publicItemId: itemIdentities[itemIndex++]!.itemId,
    })));
    const deliveredSteerClientMessageIds: string[] = [];
    const usageObservations: WorkbenchTranscriptAtomicObservation[] = [];
    if (options.settleUsage && turns.length) {
      const latestTurn = turns.at(-1)!;
      const latestMessage = messages.at(-1);
      const latestAssistant = latestMessage?.type === "assistant" && latestMessage.tokens
        ? latestMessage as SessionMessageAssistant : null;
      if (latestAssistant?.tokens) {
        const modelContextWindow = await this.owners.modelContext?.(
          latestAssistant.model,
          nativeLocation,
        ) ?? null;
        usageObservations.push({
          kind: "turnUsageContext",
          model: `${latestAssistant.model.providerID}/${latestAssistant.model.id}`,
          observedAt: latestAssistant.time.completed ?? latestAssistant.time.created,
          serviceTier: null,
          threadId: identity.threadId,
          turnId: latestTurn.turnId,
        }, {
          kind: "turnTokenUsage",
          cumulative: tokenBreakdown(session.tokens),
          observedAt: latestAssistant.time.completed ?? latestAssistant.time.created,
          threadId: identity.threadId,
          turnId: latestTurn.turnId,
          usageDataVersion: WORKBENCH_STATS_USAGE_DATA_VERSION,
        }, {
          kind: "threadContextUsage",
          threadId: identity.threadId,
          snapshot: {
            tokenUsage: {
              last: tokenBreakdown(latestAssistant.tokens),
              total: tokenBreakdown(session.tokens),
              modelContextWindow,
            },
          },
          initialise: false,
        });
      } else if (latestMessage?.type === "compaction") {
        usageObservations.push({
          kind: "threadContextUsage",
          threadId: identity.threadId,
          snapshot: { tokenUsage: null },
          initialise: false,
        });
      }
    }
    const observations = [{
      kind: "thread" as const,
      threadId: WorkbenchThreadIdSchema.parse(identity.threadId),
      projectId: ProjectIdSchema.parse(project.id),
      projectRoot: project.rootPath,
      title: session.title ?? "New thread",
      createdAt: session.time.created,
      updatedAt: session.time.updated,
      activityAt: session.time.updated,
    }, ...groups.flatMap((group, index) => {
      const turn = turns[index]!;
      const first = group.messages[0]!;
      const last = group.messages.at(-1)!;
      const assistant = [...group.messages].reverse().find(message => message.type === "assistant") as SessionMessageAssistant | undefined;
      const latestSteerIndex = group.messages.findLastIndex(message => workbenchMetadata(message)?.delivery === "steer");
      const latestAssistantIndex = group.messages.findLastIndex(message => message.type === "assistant");
      const keepOpen = index === groups.length - 1
        && (options.keepLatestTurnOpen || latestSteerIndex > latestAssistantIndex);
      const completedAt = keepOpen
        ? null
        : assistant?.time.completed ?? (index < groups.length - 1 ? last.time.created : null);
      return [{
        kind: "turn" as const,
        threadId: identity.threadId,
        turnId: turn.turnId,
        nativeTurnId: NativeTurnIdSchema.parse(group.nativeTurnId),
        nativeThreadId,
        nativeLocation,
        harnessId: "opencode",
        state: completedAt === null ? "inProgress" as const : assistant?.error ? "failed" as const : "completed" as const,
        createdAt: first.time.created,
        startedAt: first.time.created,
        endedAt: completedAt,
        durationMs: completedAt === null ? null : Math.max(0, completedAt - first.time.created),
      }, ...publicTranslated[index]!.map((entry) => {
        if (entry.kind === "steer") {
          deliveredSteerClientMessageIds.push(entry.metadata.clientMessageId);
          const steer: OpenCodeSteerEntry = {
            threadId: identity.threadId,
            turnId: turn.turnId,
            itemId: entry.metadata.itemId,
            entryKey: entry.metadata.itemId,
            input: steerInput(entry.metadata.input),
            status: "sent",
            attemptedAt: entry.observedAt,
            resolvedAt: entry.observedAt,
            requestId: null,
            canonicalItemId: entry.metadata.itemId,
            clientUserMessageId: entry.metadata.clientMessageId,
            dispatchSequence: null,
            error: null,
          };
          return {
            kind: "steer" as const,
            entry: steer,
            publicItemId: entry.publicItemId,
            observedAt: entry.observedAt,
          };
        }
        const { item, message, publicItemId } = entry;
        const completedAt = message.type === "assistant" ? message.time.completed : undefined;
        const lifecycle: WorkbenchTranscriptItemLifecycle = message.type === "assistant" && !completedAt
          || message.type === "compaction" && message.status === "running"
          ? "streaming"
          : "completed";
        return {
          kind: "item" as const,
          threadId: identity.threadId,
          turnId: turn.turnId,
          publicItemId,
          item: { ...item, id: publicItemId },
          lifecycle,
          observedAt: completedAt ?? message.time.created,
        };
      })];
    }), ...usageObservations];
    await this.owners.transcript.record(observations as WorkbenchTranscriptAtomicObservation[], { source: "provider" });
    return {
      ...identity,
      latestTurnId: turns.at(-1)?.turnId ?? null,
      deliveredSteerClientMessageIds,
    };
  }
}
