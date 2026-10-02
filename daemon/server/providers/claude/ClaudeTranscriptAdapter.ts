/*
 * Exports:
 * - claudeTokenBreakdown: convert one Claude usage record into Workbench token accounting.
 * - ClaudeTranscriptTurnState: plain in-flight transcript state of one live turn, handed across bridge reloads.
 * - default ClaudeTranscriptAdapter: admit Claude session, turn, streamed item, native tool (with effective Edit/Write diffs and claim denials), steer, screenshot steer, context and billing usage, and compaction facts to canonical history.
 */
import path from "node:path";
import type {
  SDKAssistantMessage, SDKCompactBoundaryMessage, SDKPartialAssistantMessage, SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema, WorkbenchItemIdSchema,
  WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
  type WorkbenchThreadId, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import type { WorkbenchQuestionnaireHistoryEntryState } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadTokenUsage } from "workbench-shared/workbench/thread/thread-context-usage";
import { WORKBENCH_STATS_USAGE_DATA_VERSION } from "workbench-shared/workbench/stats/workbench-stats-usage";
import { createAgentScreenshotSteerText } from "workbench-shared/workbench/thread/thread-steer-markers";
import { randomUUID } from "node:crypto";
import externalizeCodexTranscriptInlineImages from "../../codex-transcript-image-assets";
import type WorkbenchDatabaseController from "../../database/WorkbenchDatabaseController";
import type { WorkbenchToolTranscriptReference, ProviderToolResult } from "workbench-shared/workbench/provider/provider-execution";
import { ProviderToolMetadataSchema, type ProviderToolMetadata } from "workbench-shared/workbench/provider/provider-execution";
import type { ClaudeFileChangeMetadata } from "workbench-shared/workbench/provider/claude-file-change-metadata";
import type WorkbenchThreadIdentityController from "../../WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "../../WorkbenchTranscriptIdentityController";
import type { DaemonTranscriptRegistration } from "../../daemon-runtime-objects";
import type { WorkbenchTranscriptItemLifecycle } from "../../database/transcript/workbench-transcript-types";

interface TurnScope {
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
  nativeThreadId: ReturnType<typeof NativeThreadIdSchema.parse>;
  nativeTurnId: ReturnType<typeof NativeTurnIdSchema.parse>;
  nativeLocation: string;
  createdAt: number;
  startedAt: number;
  turnIndex: number;
}

type StreamedKind = "text" | "thinking";
interface StreamedBlock { kind: StreamedKind; itemId: string; reference: string; text: string }
interface TurnStream {
  threadId: WorkbenchThreadId;
  messageId: string | null;
  open: Map<number, StreamedBlock>;
  streamedMessageIds: Set<string>;
}

type NativeToolCall = { turnId: WorkbenchTurnId; itemId: string; tool: string; arguments: ProviderToolMetadata };

export interface ClaudeTranscriptTurnState {
  scope: TurnScope;
  stream: { threadId: WorkbenchThreadId; messageId: string | null; open: [number, StreamedBlock][]; streamedMessageIds: string[] } | null;
  nativeTools: [string, NativeToolCall][];
  denials: string[];
}

type ClaudeUsage = SDKAssistantMessage["message"]["usage"];

export function claudeTokenBreakdown(usage: Pick<ClaudeUsage,
  "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens">) {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const inputTokens = usage.input_tokens + cacheWrite + cacheRead;
  return {
    cacheWriteInputTokens: cacheWrite,
    cachedInputTokens: cacheRead,
    inputTokens,
    outputTokens: usage.output_tokens,
    // Claude counts thinking inside output tokens.
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + usage.output_tokens,
  };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Render Claude's structuredPatch hunks as unified diff text; null when the shape is not a hunk list. */
function unifiedHunks(value: unknown) {
  if (!Array.isArray(value)) return null;
  const hunks: string[] = [];
  for (const entry of value) {
    const hunk = record(entry);
    const numbers = [hunk?.oldStart, hunk?.oldLines, hunk?.newStart, hunk?.newLines];
    if (!hunk || !numbers.every(Number.isSafeInteger) || !Array.isArray(hunk.lines)
      || !hunk.lines.every(line => typeof line === "string")) return null;
    hunks.push([`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines].join("\n"));
  }
  return hunks.join("\n");
}

/** Effective change from Claude's Edit/Write result, matched to the call's own target path. */
function claudeFileChange(tool: string, args: ProviderToolMetadata, result: unknown): ClaudeFileChangeMetadata["fileChange"] | null {
  const output = record(result);
  if ((tool !== "Edit" && tool !== "Write") || !output || typeof args.file_path !== "string"
    || typeof output.filePath !== "string" || path.resolve(output.filePath) !== path.resolve(args.file_path)) return null;
  const hunks = unifiedHunks(output.structuredPatch);
  if (hunks === null) return null;
  if (tool === "Edit") return output.staged === true ? null : { kind: "update", diff: hunks };
  if (output.type === "create") {
    return { kind: "add", diff: hunks || (typeof output.content === "string" ? output.content : "") };
  }
  return output.type === "update" ? { kind: "update", diff: hunks } : null;
}

function blockItem(kind: StreamedKind, text: string): ThreadItem {
  return kind === "text"
    ? { type: "agentMessage", id: "pending", text, phase: null, memoryCitation: null, delivery: null, questions: null }
    : { type: "reasoning", id: "pending", summary: [], content: [text] };
}

export default class ClaudeTranscriptAdapter {
  private readonly turns = new Map<WorkbenchTurnId, TurnScope>();
  private readonly streams = new Map<WorkbenchTurnId, TurnStream>();
  private readonly nativeTools = new Map<string, NativeToolCall>();
  /** Claim denials arrive from the in-process hook, independently of when the tool_use message is consumed. */
  private readonly nativeToolDenials = new Map<string, WorkbenchTurnId>();

  constructor(private readonly owners: {
    threads: Pick<WorkbenchThreadIdentityController, "observe" | "observeTurn">;
    items: Pick<WorkbenchTranscriptIdentityController, "admit">;
    transcript: Pick<DaemonTranscriptRegistration, "record" | "acceptLiveUpdate" | "readContextUsage">;
    assets?: Pick<WorkbenchDatabaseController, "writeTranscriptAsset">;
  }) {}

  /** Copy one paused turn's in-flight state for the next bridge generation; null when it has no admitted scope. */
  captureTurn(turnId: WorkbenchTurnId): ClaudeTranscriptTurnState | null {
    const scope = this.turns.get(turnId);
    if (!scope) return null;
    const stream = this.streams.get(turnId);
    return {
      scope: { ...scope },
      stream: stream ? {
        threadId: stream.threadId, messageId: stream.messageId,
        open: [...stream.open].map(([index, block]) => [index, { ...block }]),
        streamedMessageIds: [...stream.streamedMessageIds],
      } : null,
      nativeTools: [...this.nativeTools].filter(([, call]) => call.turnId === turnId).map(([id, call]) => [id, { ...call }]),
      denials: [...this.nativeToolDenials].filter(([, owner]) => owner === turnId).map(([id]) => id),
    };
  }

  /** Continue a turn captured by a previous generation; denials recorded here meanwhile are kept. */
  restoreTurn(state: ClaudeTranscriptTurnState) {
    const { turnId } = state.scope;
    this.turns.set(turnId, { ...state.scope });
    if (state.stream) {
      this.streams.set(turnId, {
        threadId: state.stream.threadId, messageId: state.stream.messageId,
        open: new Map(state.stream.open.map(([index, block]) => [index, { ...block }])),
        streamedMessageIds: new Set(state.stream.streamedMessageIds),
      });
    }
    for (const [id, call] of state.nativeTools) this.nativeTools.set(id, { ...call });
    for (const id of state.denials) this.nativeToolDenials.set(id, turnId);
  }

  async create(sessionId: string, cwd: string, project: { id: string; rootPath: string; launchId?: string }) {
    const now = Date.now();
    const identity = await this.owners.threads.observe({
      native: { harness: "claude", nativeLocation: cwd, nativeThreadId: NativeThreadIdSchema.parse(sessionId) },
      projectId: ProjectIdSchema.parse(project.id), projectRoot: project.rootPath,
      ...(project.launchId ? { launchId: project.launchId } : {}),
      title: "New thread", createdAt: now, updatedAt: now, activityAt: now,
    });
    await this.owners.transcript.record([{
      kind: "thread", threadId: identity.threadId, projectId: ProjectIdSchema.parse(project.id),
      projectRoot: project.rootPath, title: "New thread", createdAt: now, updatedAt: now, activityAt: now,
    }], { source: "provider" });
    return identity.threadId;
  }

  async rename(threadId: WorkbenchThreadId, project: { id: string; rootPath: string; createdAt: number }, title: string) {
    const now = Date.now();
    await this.owners.transcript.record([{
      kind: "thread", threadId, projectId: ProjectIdSchema.parse(project.id),
      projectRoot: project.rootPath, title, createdAt: project.createdAt,
      updatedAt: now, activityAt: now,
    }], { source: "provider" });
  }

  async startTurn(input: {
    threadId: WorkbenchThreadId; sessionId: string; cwd: string; clientMessageId: string;
    content: Extract<ThreadItem, { type: "userMessage" }>["content"];
  }) {
    const now = Date.now();
    const nativeThreadId = NativeThreadIdSchema.parse(input.sessionId);
    const nativeTurnId = NativeTurnIdSchema.parse(input.clientMessageId);
    const turn = await this.owners.threads.observeTurn({
      kind: "turn",
      threadId: input.threadId, turnId: WorkbenchTurnIdSchema.parse(input.clientMessageId),
      nativeTurnId, nativeThreadId, nativeLocation: input.cwd, harnessId: "claude",
      state: "inProgress", createdAt: now, startedAt: now, endedAt: null, durationMs: null,
    });
    const scope: TurnScope = {
      threadId: input.threadId, turnId: turn.turnId, nativeThreadId, nativeTurnId,
      nativeLocation: input.cwd, createdAt: now, startedAt: now, turnIndex: turn.turnIndex,
    };
    this.turns.set(turn.turnId, scope);
    await this.owners.transcript.record([{
      kind: "turn", ...scope, harnessId: "claude", state: "inProgress", endedAt: null, durationMs: null,
    }], { source: "provider" });
    await this.recordItem(input.threadId, turn.turnId, `user:${input.clientMessageId}`, {
      type: "userMessage", id: input.clientMessageId, clientId: input.clientMessageId,
      content: input.content,
    }, now);
    return turn.turnId;
  }

  /** A delivered screenshot shows in the transcript as the marked image steer every provider renders. */
  async recordScreenshotSteer(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, imageUrl: string) {
    const reference = `screenshot:${randomUUID()}`;
    const item = (await externalizeCodexTranscriptInlineImages<ThreadItem>({
      type: "userMessage", id: reference, clientId: null,
      content: [
        { type: "text", text: createAgentScreenshotSteerText(), text_elements: [] },
        { type: "image", url: imageUrl },
      ],
    }, { assets: this.owners.assets, threadId })).value;
    await this.recordItem(threadId, turnId, reference, item, Date.now(), "workbench");
  }

  async recordItem(
    threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, reference: string, item: ThreadItem,
    observedAt = Date.now(), source: "provider" | "workbench" = "provider",
    lifecycle: WorkbenchTranscriptItemLifecycle = "completed",
  ) {
    const [identity] = await this.owners.items.admit([{
      threadId, sources: [{ turnId, kind: "stable", reference }],
    }]);
    const itemId = identity!.itemId;
    await this.owners.transcript.record([{
      kind: "item", threadId, turnId, publicItemId: itemId,
      item: { ...item, id: itemId }, lifecycle, observedAt,
    }], { source });
    return itemId;
  }

  /** Stream text and thinking blocks; their completed form is recorded from the same buffer. */
  async recordStreamEvent(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, message: SDKPartialAssistantMessage) {
    if (message.parent_tool_use_id) return;
    const stream = this.streams.get(turnId)
      ?? { threadId, messageId: null, open: new Map(), streamedMessageIds: new Set<string>() };
    this.streams.set(turnId, stream);
    const event = message.event;
    if (event.type === "message_start") {
      stream.messageId = event.message.id;
      return;
    }
    if (!stream.messageId) return;
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block.type !== "text" && block.type !== "thinking") return;
      const kind: StreamedKind = block.type;
      const text = block.type === "text" ? block.text : block.thinking;
      const reference = `assistant:${stream.messageId}:${event.index}`;
      stream.streamedMessageIds.add(stream.messageId);
      const itemId = await this.recordItem(threadId, turnId, reference, blockItem(kind, text), Date.now(), "provider", "streaming");
      stream.open.set(event.index, { kind, itemId, reference, text });
    } else if (event.type === "content_block_delta") {
      const block = stream.open.get(event.index);
      const text = event.delta.type === "text_delta" ? event.delta.text
        : event.delta.type === "thinking_delta" ? event.delta.thinking : "";
      if (!block || !text) return;
      block.text += text;
      this.owners.transcript.acceptLiveUpdate?.({
        kind: "text", threadId, turnId, itemId: block.itemId,
        field: block.kind === "text" ? "agentMessageText" : "reasoningContent",
        index: block.kind === "text" ? null : 0, text, append: true,
      });
    } else if (event.type === "content_block_stop") {
      const block = stream.open.get(event.index);
      if (!block) return;
      stream.open.delete(event.index);
      await this.recordItem(threadId, turnId, block.reference, blockItem(block.kind, block.text));
    }
  }

  async recordAssistant(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, message: SDKAssistantMessage) {
    if (message.parent_tool_use_id) return;
    const streamed = this.streams.get(turnId)?.streamedMessageIds.has(message.message.id) ?? false;
    for (const [index, block] of message.message.content.entries()) {
      if (block.type === "text" && !streamed) {
        await this.recordItem(threadId, turnId, `assistant:${message.uuid}:text:${index}`, blockItem("text", block.text));
      } else if (block.type === "thinking" && !streamed) {
        await this.recordItem(threadId, turnId, `assistant:${message.uuid}:thinking:${index}`, blockItem("thinking", block.thinking));
      } else if (block.type === "tool_use" && !block.name.startsWith("mcp__wb__")) {
        const itemId = await this.recordItem(threadId, turnId, `tool:${block.id}`, {
          type: "dynamicToolCall", id: block.id, namespace: "claude", tool: block.name,
          arguments: ProviderToolMetadataSchema.parse(block.input), status: "inProgress",
          contentItems: null, success: null, durationMs: null,
        });
        this.nativeTools.set(block.id, {
          turnId, itemId, tool: block.name,
          arguments: ProviderToolMetadataSchema.parse(block.input),
        });
      }
    }
  }

  /** Mark a native file call Workbench denied for missing claims; its errored result carries the marker. */
  recordNativeToolDenial(turnId: WorkbenchTurnId, toolUseId: string) {
    this.nativeToolDenials.set(toolUseId, turnId);
  }

  async recordNativeToolResults(threadId: WorkbenchThreadId, message: SDKUserMessage) {
    if (!Array.isArray(message.message.content)) return;
    for (const block of message.message.content) {
      if (block.type !== "tool_result") continue;
      const pending = this.nativeTools.get(block.tool_use_id);
      if (!pending) continue;
      const text = typeof block.content === "string" ? block.content
        : Array.isArray(block.content) ? block.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") : "";
      const denied = this.nativeToolDenials.delete(block.tool_use_id);
      const fileChange = block.is_error ? null : claudeFileChange(pending.tool, pending.arguments, message.tool_use_result);
      const metadata: ClaudeFileChangeMetadata = {
        ...(fileChange ? { fileChange } : {}),
        ...(denied && block.is_error ? { workbenchFailureKind: "unclaimed" as const } : {}),
      };
      await this.recordItem(threadId, pending.turnId, `tool:${block.tool_use_id}`, {
        type: "dynamicToolCall", id: pending.itemId, namespace: "claude", tool: pending.tool,
        arguments: pending.arguments, status: block.is_error ? "failed" : "completed",
        contentItems: text ? [{ type: "inputText", text }] : null,
        success: !block.is_error, durationMs: null,
        ...(Object.keys(metadata).length ? { metadata: { ...metadata } } : {}),
      });
      this.nativeTools.delete(block.tool_use_id);
    }
  }

  async recordCompaction(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, message: SDKCompactBoundaryMessage) {
    await this.recordItem(threadId, turnId, `compact:${message.uuid}`, {
      type: "contextCompaction", id: message.uuid,
    });
    await this.recordContextUsage(threadId, null);
  }

  readContextUsage(threadId: WorkbenchThreadId) {
    return this.owners.transcript.readContextUsage(threadId);
  }

  async recordContextUsage(threadId: WorkbenchThreadId, tokenUsage: ThreadTokenUsage | null) {
    await this.owners.transcript.record([{
      kind: "threadContextUsage", threadId, snapshot: { tokenUsage }, initialise: false,
    }], { source: "provider" });
  }

  /** Record the turn's billing model and the thread's cumulative usage for statistics. */
  async recordTurnUsage(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, usage: {
    model: string | null; mixedModels: boolean; cumulative: ThreadTokenUsage["total"]; observedAt: number;
  }) {
    await this.owners.transcript.record([{
      kind: "turnUsageContext", threadId, turnId, model: usage.model, modelChanged: usage.mixedModels,
      observedAt: usage.observedAt, serviceTier: null,
    }, {
      kind: "turnTokenUsage", threadId, turnId, cumulative: usage.cumulative,
      observedAt: usage.observedAt, usageDataVersion: WORKBENCH_STATS_USAGE_DATA_VERSION,
    }], { source: "provider" });
  }

  async settleTurn(turnId: WorkbenchTurnId, state: "completed" | "failed" | "interrupted") {
    const scope = this.turns.get(turnId);
    if (!scope) throw new Error("Claude turn has no admitted transcript scope.");
    // Blocks cut off by interruption or failure keep the text that streamed.
    for (const block of this.streams.get(turnId)?.open.values() ?? []) {
      await this.recordItem(scope.threadId, turnId, block.reference, blockItem(block.kind, block.text));
    }
    this.streams.delete(turnId);
    const endedAt = Date.now();
    await this.owners.transcript.record([{
      kind: "turn", ...scope, harnessId: "claude", state, endedAt,
      durationMs: Math.max(0, endedAt - scope.startedAt),
    }], { source: "provider" });
    this.turns.delete(turnId);
    for (const [toolId, tool] of this.nativeTools) {
      if (tool.turnId === turnId) this.nativeTools.delete(toolId);
    }
    for (const [toolId, deniedTurnId] of this.nativeToolDenials) {
      if (deniedTurnId === turnId) this.nativeToolDenials.delete(toolId);
    }
  }

  async recordSteer(entry: WorkbenchSteerHistoryEntry) {
    const threadId = WorkbenchThreadIdSchema.parse(entry.threadId);
    const turnId = WorkbenchTurnIdSchema.parse(entry.turnId);
    const itemId = WorkbenchItemIdSchema.parse(entry.itemId);
    await this.owners.items.admit([{
      threadId, itemId, sources: [{ turnId, kind: "stable", reference: itemId }],
    }]);
    await this.owners.transcript.record([{
      kind: "steer",
      entry: {
        ...entry, threadId, turnId,
      },
      publicItemId: itemId,
      observedAt: entry.resolvedAt ?? entry.attemptedAt,
    }], { source: "workbench" });
  }

  async recordQuestionnaire(entry: WorkbenchQuestionnaireHistoryEntryState) {
    await this.owners.transcript.record([{
      kind: "questionnaire",
      entry: {
        ...entry, itemId: entry.itemId ?? null,
        insertAfterItemId: entry.insertAfterItemId ?? null,
        insertAfterItemIndex: entry.insertAfterItemIndex ?? null,
        threadId: WorkbenchThreadIdSchema.parse(entry.threadId),
        turnId: WorkbenchTurnIdSchema.parse(entry.turnId),
      },
      observedAt: entry.resolvedAt,
    }], { source: "workbench" });
  }

  async startToolTranscript(input: {
    threadId: WorkbenchThreadId; turnId: WorkbenchTurnId; tool: string;
    arguments: WorkbenchToolTranscriptReference["arguments"];
  }): Promise<WorkbenchToolTranscriptReference> {
    const startedAt = Date.now();
    const sourceId = `mcp:${crypto.randomUUID()}`;
    const itemId = await this.recordItem(input.threadId, input.turnId, sourceId, {
      type: "mcpToolCall", id: sourceId, server: "wb", tool: input.tool,
      arguments: input.arguments, status: "inProgress", toolCallGroupId: sourceId,
      appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null,
    }, startedAt, "workbench");
    return { ...input, itemId, sourceId, parentId: sourceId, startedAt };
  }

  async finishToolTranscript(reference: WorkbenchToolTranscriptReference, result: ProviderToolResult) {
    await this.recordItem(reference.threadId, reference.turnId, reference.sourceId, {
      type: "mcpToolCall", id: reference.itemId, server: "wb", tool: reference.tool,
      arguments: reference.arguments, status: result.isError ? "failed" : "completed",
      toolCallGroupId: reference.parentId, appContext: null, pluginId: null, readOnlyHint: null,
      result: { content: result.content, structuredContent: result.structuredContent ?? null, _meta: result._meta ?? null },
      error: null, durationMs: Math.max(0, Date.now() - reference.startedAt),
    }, Date.now(), "workbench");
  }
}
