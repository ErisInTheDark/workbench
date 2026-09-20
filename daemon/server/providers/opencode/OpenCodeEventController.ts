/*
 * Exports:
 * - OpenCodeEventControllerOptions: provider-local event, transcript, and lifecycle ports.
 * - default OpenCodeEventController: translate OpenCode events into direct live facts and one terminal canonical settlement.
 */
import type { OpenCodeEvent, SessionToolFailed, SessionToolSuccess } from "@opencode/client";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type { JsonValue, ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  type WorkbenchThreadId, type WorkbenchTurnId, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import { openCodeToolContentItems } from "./OpenCodeTranscriptAdapter";
import type OpenCodeTranscriptAdapter from "./OpenCodeTranscriptAdapter";
import { openCodeContentSource, openCodeItemSource } from "./open-code-source-id";

type ActiveTurn = { threadId: WorkbenchThreadId; turnId: WorkbenchTurnId };

export interface OpenCodeEventControllerOptions {
  invalidateModelCatalogs?(): void;
  observe(facts: WorkbenchProviderObservation): Promise<void>;
  threads: {
    consumeRequestedInterrupt?(nativeThreadId: string): boolean;
    currentTurn(nativeThreadId: string): ActiveTurn | null;
    latestTurn(threadId: string): Promise<{ id: string } | null>;
    markExecutionSettled(nativeThreadId: string): void;
    markExecutionStarted(nativeThreadId: string): void;
    syncNative(nativeThreadId: string): Promise<{ threadId: WorkbenchThreadId; hasPendingSteers?: boolean }>;
  };
  transcript: Pick<OpenCodeTranscriptAdapter, "appendText" | "recordItem" | "recordTurnState">;
}

interface ToolState {
  input: JsonValue;
  name: string;
  startedAt: number;
}
type DynamicToolItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

function parseToolInput(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

export default class OpenCodeEventController {
  private readonly tools = new Map<string, Map<string, ToolState>>();

  constructor(private readonly options: OpenCodeEventControllerOptions) {}

  async accept(event: OpenCodeEvent) {
    if (event.type === "model.updated" || event.type === "provider.updated") {
      this.options.invalidateModelCatalogs?.();
      return;
    }
    const sessionID = "data" in event && event.data && "sessionID" in event.data
      ? event.data.sessionID as string
      : null;
    if (!sessionID) return;

    switch (event.type) {
      case "session.created":
      case "session.renamed":
        await this.options.threads.syncNative(sessionID);
        return;
      case "session.inbox.delivered": {
        const identity = await this.options.threads.syncNative(sessionID);
        const turn = await this.options.threads.latestTurn(identity.threadId);
        if (!turn) return;
        await this.options.observe({
          activity: null,
          lifecycle: {
            threadId: identity.threadId,
            event: { kind: "acceptedIntent", turnId: WorkbenchTurnIdSchema.parse(turn.id) },
          },
          title: null,
        });
        return;
      }
      case "session.execution.started": {
        this.options.threads.markExecutionStarted(sessionID);
        const active = await this.active(sessionID);
        await this.options.transcript.recordTurnState({
          ...active,
          state: "inProgress",
          observedAt: event.created,
        });
        await this.options.observe({
          activity: { kind: "turnStarted", threadId: active.threadId, startedAt: event.created },
          lifecycle: {
            threadId: active.threadId,
            event: { kind: "acceptedIntent", turnId: active.turnId },
          },
          title: null,
        });
        return;
      }
      case "session.text.started": {
        const active = await this.active(sessionID);
        await this.options.transcript.recordItem({
          ...active,
          source: openCodeContentSource(event.data.assistantMessageID, "text", event.data.ordinal),
          item: this.agentMessage(""),
          lifecycle: "streaming",
          observedAt: event.created,
        });
        return;
      }
      case "session.text.delta": {
        const active = await this.active(sessionID);
        this.options.transcript.appendText({
          ...active,
          source: openCodeContentSource(event.data.assistantMessageID, "text", event.data.ordinal),
          field: "agentMessageText",
          index: null,
          text: event.data.delta,
        });
        return;
      }
      case "session.text.ended": {
        const active = await this.active(sessionID);
        await this.options.transcript.recordItem({
          ...active,
          source: openCodeContentSource(event.data.assistantMessageID, "text", event.data.ordinal),
          item: this.agentMessage(event.data.text),
          lifecycle: "completed",
          observedAt: event.created,
        });
        return;
      }
      case "session.reasoning.started": {
        const active = await this.active(sessionID);
        await this.options.transcript.recordItem({
          ...active,
          source: openCodeContentSource(event.data.assistantMessageID, "reasoning", event.data.ordinal),
          item: this.reasoning(""),
          lifecycle: "streaming",
          observedAt: event.created,
        });
        return;
      }
      case "session.reasoning.delta": {
        const active = await this.active(sessionID);
        this.options.transcript.appendText({
          ...active,
          source: openCodeContentSource(event.data.assistantMessageID, "reasoning", event.data.ordinal),
          field: "reasoningContent",
          index: 0,
          text: event.data.delta,
        });
        return;
      }
      case "session.reasoning.ended": {
        const active = await this.active(sessionID);
        await this.options.transcript.recordItem({
          ...active,
          source: openCodeContentSource(event.data.assistantMessageID, "reasoning", event.data.ordinal),
          item: this.reasoning(event.data.text),
          lifecycle: "completed",
          observedAt: event.created,
        });
        return;
      }
      case "session.tool.input.started": {
        this.setTool(sessionID, event.data.id, { input: "", name: event.data.name, startedAt: event.created });
        await this.recordTool(sessionID, event.data.id, "inProgress", event.created);
        return;
      }
      case "session.tool.input.ended": {
        const previous = this.getTool(sessionID, event.data.id);
        this.setTool(sessionID, event.data.id, {
          input: parseToolInput(event.data.text),
          name: previous?.name ?? "unknown",
          startedAt: previous?.startedAt ?? event.created,
        });
        await this.recordTool(sessionID, event.data.id, "inProgress", event.created);
        return;
      }
      case "session.tool.called": {
        const previous = this.getTool(sessionID, event.data.id);
        this.setTool(sessionID, event.data.id, {
          input: event.data.input,
          name: previous?.name ?? "unknown",
          startedAt: previous?.startedAt ?? event.created,
        });
        await this.recordTool(sessionID, event.data.id, "inProgress", event.created);
        return;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const previous = this.getTool(sessionID, event.data.id);
        const active = await this.active(sessionID);
        await this.options.transcript.recordItem({
          ...active,
          source: openCodeItemSource(event.data.id),
          item: {
            ...this.toolItem(event.data.id, previous, event.type === "session.tool.success" ? "completed" : "failed"),
            contentItems: openCodeToolContentItems(
              event.data.content,
              event.type === "session.tool.failed" ? event.data.error : undefined,
            ),
            success: event.type === "session.tool.success",
            durationMs: previous ? Math.max(0, event.created - previous.startedAt) : null,
          },
          lifecycle: "completed",
          observedAt: event.created,
        });
        this.deleteTool(sessionID, event.data.id);
        return;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const requestedInterrupt = this.options.threads.consumeRequestedInterrupt?.(sessionID) ?? false;
        const identity = await this.options.threads.syncNative(sessionID);
        if (event.type === "session.execution.succeeded" && identity.hasPendingSteers) return;
        this.options.threads.markExecutionSettled(sessionID);
        const turn = await this.options.threads.latestTurn(identity.threadId);
        if (!turn) return;
        const status = requestedInterrupt ? "interrupted"
          : event.type === "session.execution.succeeded" ? "completed"
          : event.type === "session.execution.interrupted" ? "interrupted" : "failed";
        if (status !== "completed") {
          await this.options.transcript.recordTurnState({
            threadId: identity.threadId,
            turnId: WorkbenchTurnIdSchema.parse(turn.id),
            state: status,
            observedAt: event.created,
          });
        }
        await this.options.observe({
          activity: null,
          lifecycle: {
            threadId: identity.threadId,
            event: {
              kind: "turnCompleted",
              turnId: WorkbenchTurnIdSchema.parse(turn.id),
              status,
            },
          },
          title: null,
        });
      }
    }
  }

  private async active(sessionID: string): Promise<ActiveTurn> {
    const current = this.options.threads.currentTurn(sessionID);
    if (current) return current;
    await this.options.threads.syncNative(sessionID);
    const recovered = this.options.threads.currentTurn(sessionID);
    if (!recovered) throw new Error("OpenCode event has no admitted Workbench turn.");
    return recovered;
  }

  private async recordTool(sessionID: string, id: string, status: "inProgress", observedAt: number) {
    const active = await this.active(sessionID);
    await this.options.transcript.recordItem({
      ...active,
      source: openCodeItemSource(id),
      item: this.toolItem(id, this.getTool(sessionID, id), status),
      lifecycle: "streaming",
      observedAt,
    });
  }

  private getTool(sessionID: string, id: string) {
    return this.tools.get(sessionID)?.get(id);
  }

  private setTool(sessionID: string, id: string, state: ToolState) {
    const sessionTools = this.tools.get(sessionID) ?? new Map<string, ToolState>();
    sessionTools.set(id, state);
    this.tools.set(sessionID, sessionTools);
  }

  private deleteTool(sessionID: string, id: string) {
    const sessionTools = this.tools.get(sessionID);
    if (!sessionTools) return;
    sessionTools.delete(id);
    if (!sessionTools.size) this.tools.delete(sessionID);
  }

  private toolItem(id: string, state: ToolState | undefined, status: "inProgress" | "completed" | "failed"): DynamicToolItem {
    return {
      type: "dynamicToolCall",
      id,
      namespace: "opencode",
      tool: state?.name ?? "unknown",
      arguments: state?.input ?? {},
      status,
      contentItems: null,
      success: status === "completed" ? true : status === "failed" ? false : null,
      durationMs: null,
    };
  }

  private agentMessage(text: string): ThreadItem {
    return {
      type: "agentMessage",
      id: "pending",
      text,
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
  }

  private reasoning(text: string): ThreadItem {
    return { type: "reasoning", id: "pending", summary: [], content: [text] };
  }

}
