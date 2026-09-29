/*
 * Exports:
 * - default ClaudeTranscriptAdapter: admit Claude session, turn, item, steer, and compaction facts to canonical history.
 */
import type { SDKAssistantMessage, SDKCompactBoundaryMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema, WorkbenchItemIdSchema,
  WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
  type WorkbenchThreadId, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import type { WorkbenchQuestionnaireHistoryEntryState } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchToolTranscriptReference, ProviderToolResult } from "workbench-shared/workbench/provider/provider-execution";
import { ProviderToolMetadataSchema } from "workbench-shared/workbench/provider/provider-execution";
import type WorkbenchThreadIdentityController from "../../WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "../../WorkbenchTranscriptIdentityController";
import type { DaemonTranscriptRegistration } from "../../daemon-runtime-objects";

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

export default class ClaudeTranscriptAdapter {
  private readonly turns = new Map<WorkbenchTurnId, TurnScope>();
  private readonly nativeTools = new Map<string, { turnId: WorkbenchTurnId; itemId: string; tool: string; arguments: object }>();

  constructor(private readonly owners: {
    threads: Pick<WorkbenchThreadIdentityController, "observe" | "observeTurn">;
    items: Pick<WorkbenchTranscriptIdentityController, "admit">;
    transcript: Pick<DaemonTranscriptRegistration, "record" | "acceptLiveUpdate">;
  }) {}

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

  async recordItem(
    threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, reference: string, item: ThreadItem,
    observedAt = Date.now(), source: "provider" | "workbench" = "provider",
  ) {
    const [identity] = await this.owners.items.admit([{
      threadId, sources: [{ turnId, kind: "stable", reference }],
    }]);
    const itemId = identity!.itemId;
    await this.owners.transcript.record([{
      kind: "item", threadId, turnId, publicItemId: itemId,
      item: { ...item, id: itemId }, lifecycle: "completed", observedAt,
    }], { source });
    return itemId;
  }

  async recordAssistant(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, message: SDKAssistantMessage) {
    if (message.parent_tool_use_id) return;
    for (const [index, block] of message.message.content.entries()) {
      if (block.type === "text") {
        const itemId = await this.recordItem(threadId, turnId, `assistant:${message.uuid}:text:${index}`, {
          type: "agentMessage", id: message.uuid, text: block.text, phase: null,
          memoryCitation: null, delivery: null, questions: null,
        });
        this.owners.transcript.acceptLiveUpdate?.({
          kind: "text", threadId, turnId, itemId, field: "agentMessageText",
          index: null, text: block.text, append: true,
        });
      } else if (block.type === "thinking") {
        await this.recordItem(threadId, turnId, `assistant:${message.uuid}:thinking:${index}`, {
          type: "reasoning", id: message.uuid, summary: [], content: [block.thinking],
        });
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

  async recordNativeToolResults(threadId: WorkbenchThreadId, message: SDKUserMessage) {
    if (!Array.isArray(message.message.content)) return;
    for (const block of message.message.content) {
      if (block.type !== "tool_result") continue;
      const pending = this.nativeTools.get(block.tool_use_id);
      if (!pending) continue;
      const text = typeof block.content === "string" ? block.content
        : Array.isArray(block.content) ? block.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") : "";
      await this.recordItem(threadId, pending.turnId, `tool:${block.tool_use_id}`, {
        type: "dynamicToolCall", id: pending.itemId, namespace: "claude", tool: pending.tool,
        arguments: pending.arguments, status: block.is_error ? "failed" : "completed",
        contentItems: text ? [{ type: "inputText", text }] : null,
        success: !block.is_error, durationMs: null,
      });
      this.nativeTools.delete(block.tool_use_id);
    }
  }

  async recordCompaction(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, message: SDKCompactBoundaryMessage) {
    await this.recordItem(threadId, turnId, `compact:${message.uuid}`, {
      type: "contextCompaction", id: message.uuid,
    });
  }

  async settleTurn(turnId: WorkbenchTurnId, state: "completed" | "failed" | "interrupted") {
    const scope = this.turns.get(turnId);
    if (!scope) throw new Error("Claude turn has no admitted transcript scope.");
    const endedAt = Date.now();
    await this.owners.transcript.record([{
      kind: "turn", ...scope, harnessId: "claude", state, endedAt,
      durationMs: Math.max(0, endedAt - scope.startedAt),
    }], { source: "provider" });
    this.turns.delete(turnId);
    for (const [toolId, tool] of this.nativeTools) {
      if (tool.turnId === turnId) this.nativeTools.delete(toolId);
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
