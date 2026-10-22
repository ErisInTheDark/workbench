/*
 * Exports:
 * - claudeTokenBreakdown: convert one Claude usage record into Workbench token accounting.
 * - ClaudeTranscriptTurnState: plain in-flight transcript state of one live turn, handed across bridge reloads.
 * - default ClaudeTranscriptAdapter: admit Claude session, turn, streamed item, live exact commentary-tool message, wb call
 *   (placed where the model wrote it, its request recording over that place), native tool (with effective Edit/Write diffs and claim denials), steer, screenshot steer, context and billing usage to canonical history, recover a settled turn from its session log, expose which turns this daemon still owns, and report compaction start and end to Workbench.
 */
import path from "node:path";
import type {
  SDKAssistantMessage, SDKCompactBoundaryMessage, SDKPartialAssistantMessage, SDKStatusMessage, SDKUserMessage,
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
import type { WorkbenchProviderCompactionScope } from "workbench-shared/workbench/provider/provider-thread";
import { WORKBENCH_STATS_USAGE_DATA_VERSION } from "workbench-shared/workbench/stats/workbench-stats-usage";
import { createAgentScreenshotSteerText } from "workbench-shared/workbench/thread/thread-steer-markers";
import { randomUUID } from "node:crypto";
import externalizeCodexTranscriptInlineImages from "../../transcript/codex-transcript-image-assets";
import type WorkbenchDatabaseController from "../../database/WorkbenchDatabaseController";
import type { WorkbenchToolTranscriptReference, ProviderToolResult } from "../provider-execution";
import { ProviderToolMetadataSchema, type ProviderToolMetadata } from "../provider-execution";
import type { ClaudeFileChangeMetadata } from "workbench-shared/workbench/provider/claude-file-change-metadata";
import type WorkbenchThreadIdentityController from "../../thread/WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "../../transcript/WorkbenchTranscriptIdentityController";
import type { DaemonTranscriptRegistration } from "../../daemon-runtime-objects";
import type { WorkbenchTranscriptAtomicObservation, WorkbenchTranscriptItemLifecycle } from "../../database/transcript/workbench-transcript-types";
import { CLAUDE_COMMENTARY_TOOL_NAME, CLAUDE_LEGACY_COMMENTARY_TOOL_NAME, readStreamedCommentaryText } from "./claude-commentary-tool";
import type { ClaudeSessionLogRecord } from "./claude-session-log";

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

type StreamedKind = "text" | "thinking" | "commentary";
/** Commentary blocks keep raw tool-input JSON; `text` is its decoded `text` prefix. */
interface StreamedBlock { kind: StreamedKind; itemId: string; reference: string; text: string; partialJson?: string }
interface TurnStream {
  threadId: WorkbenchThreadId;
  messageId: string | null;
  open: Map<number, StreamedBlock>;
  /** Not carried across bridge reloads: the assistant message reserves any call cut off mid-block. */
  tools: Map<number, StreamedWorkbenchCall>;
  streamedMessageIds: Set<string>;
}

type NativeToolCall = { turnId: WorkbenchTurnId; itemId: string; tool: string; arguments: ProviderToolMetadata };
/** A wb tool_use whose input is still streaming; on stop it reserves the call's place. */
interface StreamedWorkbenchCall { id: string; name: string; partialJson: string }
/**
 * A wb call's place in the transcript, by tool_use id. `reserved`: the model's block holds its place; `claimed`: its
 * request reached Workbench (or its result settled it), which now owns its body. `written` orders a start after a
 * reservation already in flight.
 */
type WorkbenchCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;
type WorkbenchCallState = {
  threadId: WorkbenchThreadId; turnId: WorkbenchTurnId; item: WorkbenchCallItem; phase: "reserved" | "claimed"; written: Promise<unknown>;
};

const WORKBENCH_TOOL_PREFIX = "mcp__wb__";

/** A wb call as the transcript holds it while it runs, named by its tool_use block as live and recovered calls share. */
function workbenchCallItem(reference: string, tool: string, args: WorkbenchCallItem["arguments"]): WorkbenchCallItem {
  return {
    type: "mcpToolCall", id: reference, server: "wb", tool,
    arguments: args, status: "inProgress", toolCallGroupId: reference,
    appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null,
  };
}

function parseToolInput(json: string): ProviderToolMetadata {
  try {
    return ProviderToolMetadataSchema.parse(json ? JSON.parse(json) : {});
  } catch {
    return {};
  }
}

export interface ClaudeTranscriptTurnState {
  scope: TurnScope;
  stream: { threadId: WorkbenchThreadId; messageId: string | null; open: [number, StreamedBlock][]; streamedMessageIds: string[] } | null;
  nativeTools: [string, NativeToolCall][];
  denials: string[];
  workbenchCalls?: [string, Omit<WorkbenchCallState, "written">][];
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
  return kind === "thinking"
    ? { type: "reasoning", id: "pending", summary: [], content: [text] }
    : {
      type: "agentMessage", id: "pending", text, phase: kind === "commentary" ? "commentary" : null,
      memoryCitation: null, delivery: null, questions: null,
    };
}

export default class ClaudeTranscriptAdapter {
  private readonly turns = new Map<WorkbenchTurnId, TurnScope>();
  private readonly streams = new Map<WorkbenchTurnId, TurnStream>();
  private readonly nativeTools = new Map<string, NativeToolCall>();
  /** Claim denials arrive from the in-process hook, independently of when the tool_use message is consumed. */
  private readonly nativeToolDenials = new Map<string, WorkbenchTurnId>();
  private readonly workbenchCalls = new Map<string, WorkbenchCallState>();

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
      workbenchCalls: [...this.workbenchCalls].filter(([, call]) => call.turnId === turnId)
        .map(([id, { written: _written, ...call }]) => [id, call]),
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
        tools: new Map(),
        streamedMessageIds: new Set(state.stream.streamedMessageIds),
      });
    }
    for (const [id, call] of state.nativeTools) this.nativeTools.set(id, { ...call });
    for (const id of state.denials) this.nativeToolDenials.set(id, turnId);
    for (const [id, call] of state.workbenchCalls ?? []) this.workbenchCalls.set(id, { ...call, written: Promise.resolve() });
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
  async recordScreenshotSteer(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, imageUrl: string, hidden = false) {
    const reference = `screenshot:${randomUUID()}`;
    const item = (await externalizeCodexTranscriptInlineImages<ThreadItem>({
      type: "userMessage", id: reference, clientId: null,
      content: [
        { type: "text", text: createAgentScreenshotSteerText({ hidden }), text_elements: [] },
        { type: "image", url: imageUrl },
      ],
    }, { assets: this.owners.assets, threadId })).value;
    await this.recordItem(threadId, turnId, reference, item, Date.now(), "workbench");
  }

  async recordItem(
    threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, reference: string, item: ThreadItem,
    observedAt = Date.now(), source: "provider" | "workbench" = "provider",
    lifecycle?: WorkbenchTranscriptItemLifecycle,
  ) {
    const resolvedLifecycle = lifecycle ?? (
      (item.type === "dynamicToolCall" || item.type === "mcpToolCall") && item.status === "inProgress"
        ? "streaming"
        : "completed"
    );
    const [identity] = await this.owners.items.admit([{
      threadId, sources: [{ turnId, kind: "stable", reference }],
    }]);
    const itemId = identity!.itemId;
    await this.owners.transcript.record([{
      kind: "item", threadId, turnId, publicItemId: itemId,
      item: { ...item, id: itemId }, lifecycle: resolvedLifecycle, observedAt,
    }], { source });
    return itemId;
  }

  /** Stream text, thinking, and commentary-tool blocks; their completed form is recorded from the same buffer. */
  async recordStreamEvent(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, message: SDKPartialAssistantMessage) {
    if (message.parent_tool_use_id) return;
    const stream = this.streams.get(turnId)
      ?? { threadId, messageId: null, open: new Map(), tools: new Map(), streamedMessageIds: new Set<string>() };
    this.streams.set(turnId, stream);
    const event = message.event;
    if (event.type === "message_start") {
      stream.messageId = event.message.id;
      return;
    }
    if (!stream.messageId) return;
    if (event.type === "content_block_start") {
      const block = event.content_block;
      // Commentary is served by wb MCP, yet it is the agent's message, not a recorded wb call.
      if (block.type === "tool_use" && block.name !== CLAUDE_COMMENTARY_TOOL_NAME && block.name.startsWith(WORKBENCH_TOOL_PREFIX)) {
        stream.tools.set(event.index, { id: block.id, name: block.name, partialJson: "" });
        return;
      }
      const opened = block.type === "text" ? { kind: "text" as const, text: block.text, reference: `assistant:${stream.messageId}:${event.index}` }
        : block.type === "thinking" ? { kind: "thinking" as const, text: block.thinking, reference: `assistant:${stream.messageId}:${event.index}` }
        : block.type === "tool_use" && block.name === CLAUDE_COMMENTARY_TOOL_NAME
          ? { kind: "commentary" as const, text: "", reference: `tool:${block.id}` } : null;
      if (!opened) return;
      stream.streamedMessageIds.add(stream.messageId);
      const itemId = await this.recordItem(threadId, turnId, opened.reference, blockItem(opened.kind, opened.text), Date.now(), "provider", "streaming");
      stream.open.set(event.index, { ...opened, itemId, ...(opened.kind === "commentary" ? { partialJson: "" } : {}) });
    } else if (event.type === "content_block_delta") {
      const tool = stream.tools.get(event.index);
      if (tool) {
        if (event.delta.type === "input_json_delta") tool.partialJson += event.delta.partial_json;
        return;
      }
      const block = stream.open.get(event.index);
      if (!block) return;
      let text = "";
      if (block.kind === "commentary") {
        if (event.delta.type !== "input_json_delta") return;
        block.partialJson = (block.partialJson ?? "") + event.delta.partial_json;
        text = readStreamedCommentaryText(block.partialJson).slice(block.text.length);
      } else {
        text = event.delta.type === "text_delta" ? event.delta.text
          : event.delta.type === "thinking_delta" ? event.delta.thinking : "";
      }
      if (!text) return;
      block.text += text;
      this.owners.transcript.acceptLiveUpdate?.({
        kind: "text", threadId, turnId, itemId: block.itemId,
        field: block.kind === "thinking" ? "reasoningContent" : "agentMessageText",
        index: block.kind === "thinking" ? 0 : null, text, append: true,
      });
    } else if (event.type === "content_block_stop") {
      const tool = stream.tools.get(event.index);
      if (tool) {
        stream.tools.delete(event.index);
        // Complete input, and stream order: the call takes its place before any block the model wrote after it.
        await this.reserveWorkbenchCall(threadId, turnId, tool.id, tool.name, parseToolInput(tool.partialJson));
        return;
      }
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
      } else if (block.type === "tool_use" && block.name === CLAUDE_COMMENTARY_TOOL_NAME) {
        // The parsed input is the exact authored text; it settles any streamed copy under the same reference.
        const text = record(block.input)?.text;
        if (typeof text === "string") await this.recordItem(threadId, turnId, `tool:${block.id}`, blockItem("commentary", text));
      } else if (block.type === "tool_use" && block.name.startsWith(WORKBENCH_TOOL_PREFIX)) {
        await this.reserveWorkbenchCall(threadId, turnId, block.id, block.name, ProviderToolMetadataSchema.parse(block.input));
      } else if (block.type === "tool_use") {
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

  /** Hold a wb call's place where the model wrote it; its request, once it lands, records over this in place. */
  private async reserveWorkbenchCall(
    threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, toolUseId: string, name: string, args: ProviderToolMetadata,
  ) {
    if (this.workbenchCalls.has(toolUseId)) return;
    const item = workbenchCallItem(`tool:${toolUseId}`, name.slice(WORKBENCH_TOOL_PREFIX.length), args);
    const written = this.recordItem(threadId, turnId, `tool:${toolUseId}`, item);
    this.workbenchCalls.set(toolUseId, { threadId, turnId, item, phase: "reserved", written });
    await written;
  }

  /** A reserved call whose request never reached its tool (rejected input, an unobserved listing) ends with its result. */
  private async settleReservedWorkbenchCall(toolUseId: string, status: "completed" | "failed", text: string) {
    const call = this.workbenchCalls.get(toolUseId);
    if (call?.phase !== "reserved") return;
    call.phase = "claimed";
    await call.written;
    await this.recordItem(call.threadId, call.turnId, `tool:${toolUseId}`, {
      ...call.item, status, result: { content: text ? [{ type: "text", text }] : [], structuredContent: null, _meta: null },
    });
  }

  /** Mark a native file call Workbench denied for missing claims; its errored result carries the marker. */
  recordNativeToolDenial(turnId: WorkbenchTurnId, toolUseId: string) {
    this.nativeToolDenials.set(toolUseId, turnId);
  }

  async recordNativeToolResults(threadId: WorkbenchThreadId, message: SDKUserMessage) {
    if (!Array.isArray(message.message.content)) return;
    for (const block of message.message.content) {
      if (block.type !== "tool_result") continue;
      const text = typeof block.content === "string" ? block.content
        : Array.isArray(block.content) ? block.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") : "";
      await this.settleReservedWorkbenchCall(block.tool_use_id, block.is_error ? "failed" : "completed", text);
      const pending = this.nativeTools.get(block.tool_use_id);
      if (!pending) continue;
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

  /** Report Claude's compaction signals; Workbench owns the item. Claude names neither start nor end, so both are unreferenced. */
  async recordCompactionMessage(
    threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, message: SDKStatusMessage | SDKCompactBoundaryMessage,
    scope?: WorkbenchProviderCompactionScope,
  ) {
    const boundary = message.subtype === "compact_boundary" ? message : null;
    const status = message.subtype === "status" ? message : null;
    // A successful status follows or precedes the boundary, which alone reports the completion.
    const phase = boundary ? "completed"
      : status?.status === "compacting" ? "started"
        : status?.compact_result === "failed" ? "failed" : null;
    if (!phase) return;
    if (phase === "failed") {
      console.warn("[claude] context compaction failed", status?.compact_error?.slice(0, 300) ?? "no reason given");
    }
    await this.reportCompaction(threadId, scope?.turnId ?? turnId, phase,
      boundary?.compact_metadata.duration_ms ?? null, scope?.itemId);
  }

  /** Unreferenced: an end settles the thread's open compaction, or records nothing without a measured duration. */
  async reportCompaction(
    threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, phase: "started" | "completed" | "failed", durationMs: number | null = null,
    itemId?: WorkbenchProviderCompactionScope["itemId"],
  ) {
    await this.owners.transcript.record([{
      kind: "contextCompaction", threadId, turnId, phase, observedAt: Date.now(), reference: null, durationMs,
      ...(itemId ? { itemId } : {}),
    }], { source: "provider" });
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

  /** True while a live turn in this daemon owns the turn's transcript scope, from admission until settlement. */
  ownsTurn(turnId: WorkbenchTurnId) {
    return this.turns.has(turnId);
  }

  async settleTurn(turnId: WorkbenchTurnId, state: "completed" | "failed" | "interrupted") {
    const scope = this.turns.get(turnId);
    if (!scope) throw new Error("Claude turn has no admitted transcript scope.");
    // Blocks cut off by interruption or failure keep the text that streamed.
    for (const block of this.streams.get(turnId)?.open.values() ?? []) {
      await this.recordItem(scope.threadId, turnId, block.reference, blockItem(block.kind, block.text));
    }
    this.streams.delete(turnId);
    // A call the model wrote that neither ran nor got a result ended with the turn.
    for (const [toolUseId, call] of this.workbenchCalls) {
      if (call.turnId !== turnId) continue;
      if (call.phase === "reserved") await this.settleReservedWorkbenchCall(toolUseId, "failed", "");
      this.workbenchCalls.delete(toolUseId);
    }
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

  /**
   * A request naming its tool_use takes over the place that block reserved, or reserves it now; one without a name
   * lands where it arrives.
   */
  async startToolTranscript(input: {
    threadId: WorkbenchThreadId; turnId: WorkbenchTurnId; tool: string;
    arguments: WorkbenchToolTranscriptReference["arguments"];
    toolUseId?: string | null;
  }): Promise<WorkbenchToolTranscriptReference> {
    const { toolUseId, ...reference } = input;
    const startedAt = Date.now();
    const sourceId = toolUseId ? `tool:${toolUseId}` : `mcp:${crypto.randomUUID()}`;
    const item = workbenchCallItem(sourceId, input.tool, input.arguments);
    const reserved = toolUseId ? this.workbenchCalls.get(toolUseId) : undefined;
    const written = (async () => {
      await reserved?.written.catch(() => undefined);
      return this.recordItem(input.threadId, input.turnId, sourceId, item, startedAt, "workbench");
    })();
    if (toolUseId) this.workbenchCalls.set(toolUseId, { threadId: input.threadId, turnId: input.turnId, item, phase: "claimed", written });
    const itemId = await written;
    return { ...reference, itemId, sourceId, parentId: sourceId, startedAt };
  }

  /**
   * Re-admit one settled turn from its native session log lines as a complete provider scope. References match
   * the live ones where the log carries them, so surviving identities are reused. The log keeps no thinking text,
   * pasted images or claim-denial markers, so those are not recovered.
   */
  async recoverTurn(turn: Extract<WorkbenchTranscriptAtomicObservation, { kind: "turn" }>, records: readonly ClaudeSessionLogRecord[], recovery: { gapIds: readonly string[]; explicit?: true }) {
    const entries = new Map<string, { item: ThreadItem; observedAt: number }>();
    const tools = new Map<string, { reference: string; mcp: boolean }>();
    let prompted = false;
    for (const { line, uuid, occurredAt } of records) {
      const message = record(line.message);
      const content = message?.content;
      if (line.type === "user") {
        if (line.isMeta === true) continue;
        if (typeof line.promptSource === "string") {
          const text = typeof content === "string" ? content
            : Array.isArray(content) ? content.flatMap(part => record(part)?.type === "text" ? [String(record(part)!.text ?? "")] : []).join("\n") : "";
          const reference = prompted ? `user:${uuid}` : `user:${turn.nativeTurnId ?? uuid}`;
          prompted = true;
          entries.set(reference, { observedAt: occurredAt, item: {
            type: "userMessage", id: reference, clientId: null, content: [{ type: "text", text, text_elements: [] }],
          } });
          continue;
        }
        for (const block of Array.isArray(content) ? content : []) {
          const result = record(block);
          if (result?.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
          const tool = tools.get(result.tool_use_id);
          const pending = tool && entries.get(tool.reference);
          if (!tool || !pending) continue;
          const failed = result.is_error === true;
          const parts = typeof result.content === "string" ? [{ type: "text", text: result.content }]
            : Array.isArray(result.content) ? result.content.flatMap(part => record(part)?.type === "text" ? [{ type: "text", text: String(record(part)!.text ?? "") }] : []) : [];
          const text = parts.map(part => part.text).join("\n");
          const item = pending.item;
          if (item.type === "mcpToolCall") {
            pending.item = { ...item, status: failed ? "failed" : "completed", result: { content: parts, structuredContent: null, _meta: null } };
          } else if (item.type === "dynamicToolCall") {
            const fileChange = failed ? null : claudeFileChange(item.tool, item.arguments as ProviderToolMetadata, line.toolUseResult);
            pending.item = {
              ...item, status: failed ? "failed" : "completed", contentItems: text ? [{ type: "inputText", text }] : null,
              success: !failed, ...(fileChange ? { metadata: { fileChange } satisfies ClaudeFileChangeMetadata } : {}),
            };
          }
        }
        continue;
      }
      const blockIndex = typeof line.apiBlockIndex === "number" ? line.apiBlockIndex : null;
      for (const [index, value] of (Array.isArray(content) ? content : []).entries()) {
        const block = record(value);
        if (!block) continue;
        const position = blockIndex ?? index;
        const native = typeof message?.id === "string" ? `assistant:${message.id}:${position}` : `assistant:${uuid}:${block.type}:${index}`;
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          entries.set(native, { observedAt: occurredAt, item: blockItem("text", block.text) });
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          entries.set(native, { observedAt: occurredAt, item: blockItem("thinking", block.thinking) });
        } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          const reference = `tool:${block.id}`;
          if (block.name === CLAUDE_COMMENTARY_TOOL_NAME || block.name === CLAUDE_LEGACY_COMMENTARY_TOOL_NAME) {
            const text = record(block.input)?.text;
            if (typeof text === "string") entries.set(reference, { observedAt: occurredAt, item: blockItem("commentary", text) });
            continue;
          }
          const mcp = block.name.startsWith(WORKBENCH_TOOL_PREFIX);
          const args = ProviderToolMetadataSchema.parse(block.input ?? {});
          tools.set(block.id, { reference, mcp });
          entries.set(reference, { observedAt: occurredAt, item: mcp ? workbenchCallItem(reference, block.name.slice(WORKBENCH_TOOL_PREFIX.length), args) : {
            type: "dynamicToolCall", id: block.id, namespace: "claude", tool: block.name,
            arguments: args, status: "inProgress", contentItems: null, success: null, durationMs: null,
          } });
        }
      }
    }
    // A recovered turn is settled; a call whose result never reached the log ended with it.
    for (const entry of entries.values()) {
      if ((entry.item.type === "dynamicToolCall" || entry.item.type === "mcpToolCall") && entry.item.status === "inProgress") {
        entry.item = { ...entry.item, status: "failed" } as ThreadItem;
      }
    }
    const references = [...entries.keys()];
    const identities = references.length ? await this.owners.items.admit(references.map(reference => ({
      threadId: turn.threadId, sources: [{ turnId: turn.turnId, kind: "stable" as const, reference }],
    }))) : [];
    const items = references.map((reference, index) => {
      const { item, observedAt } = entries.get(reference)!;
      const itemId = identities[index]!.itemId;
      return {
        kind: "item" as const, threadId: turn.threadId, turnId: turn.turnId, publicItemId: itemId,
        item: { ...item, id: itemId }, lifecycle: "completed" as const, observedAt,
      };
    });
    await this.owners.transcript.record([{
      kind: "providerTurnScope", threadId: turn.threadId, completeTurnIds: [turn.turnId], observations: [turn, ...items],
    }], { source: "provider", recovery });
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
