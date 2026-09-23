/*
 * Exports:
 * - OpenCodeEventControllerOptions: provider-local event, transcript, and lifecycle ports.
 * - default OpenCodeEventController: translate OpenCode events into direct live facts and one terminal canonical settlement.
 */
import type { OpenCodeEvent, SessionToolFailed, SessionToolSuccess } from "@opencode/client";
import type { WorkbenchProviderObservation, WorkbenchTranscriptNotification } from "workbench-shared/workbench/provider/provider-observation";
import type { JsonValue, ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { ThreadStatus, Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import {
  type WorkbenchThreadId, type WorkbenchTurnId, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import { openCodeToolContentItems } from "./OpenCodeTranscriptAdapter";
import type OpenCodeTranscriptAdapter from "./OpenCodeTranscriptAdapter";
import { openCodeContentSource, openCodeItemSource } from "./open-code-source-id";
import type { OpenCodePatchObservation } from "./opencode-workbench-rpc";
import type OpenCodeThreadOperations from "./OpenCodeThreadOperations";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";

type ActiveTurn = { threadId: WorkbenchThreadId; turnId: WorkbenchTurnId };

export interface OpenCodeEventControllerOptions {
  broadcast?(notification: WorkbenchTranscriptNotification): void;
  invalidateModelCatalogs?(): void;
  observe(facts: WorkbenchProviderObservation): Promise<WorkbenchThreadLifecycle | null | void>;
  threads: {
    consumeRequestedInterrupt?(nativeThreadId: string): boolean;
    currentTurn(nativeThreadId: string): ActiveTurn | null;
    latestTurn(threadId: string): Promise<Turn | null>;
    markExecutionSettled(nativeThreadId: string): void;
    markExecutionStarted(nativeThreadId: string): void;
    syncNative(nativeThreadId: string): Promise<{ threadId: WorkbenchThreadId; latestTurnId?: WorkbenchTurnId | null; hasPendingSteers?: boolean }>;
    syncCreatedNative?(nativeThreadId: string): Promise<{ threadId: WorkbenchThreadId } | null>;
  } & Pick<OpenCodeThreadOperations, "acceptExecutionEvent" | "completeExecution" | "executionIntentVersion">;
  transcript: Pick<OpenCodeTranscriptAdapter, "appendText" | "recordItem" | "recordTurnState">
    & Partial<Pick<OpenCodeTranscriptAdapter, "previewToolPatch">>;
}

interface ToolState {
  input: JsonValue;
  name: string;
  startedAt: number;
  active?: ActiveTurn;
  itemId?: string;
  metadata?: JsonValue;
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
  private readonly previews = new Map<string, {
    requestID: string;
    calls: Map<string, Extract<OpenCodePatchObservation, { kind: "preview" }>>;
  }>();

  constructor(private readonly options: OpenCodeEventControllerOptions) {}

  acceptPatchPreview(observation: OpenCodePatchObservation) {
    const previous = this.previews.get(observation.sessionID);
    if (observation.kind === "request") {
      this.clearPreviews(observation.sessionID);
      this.previews.set(observation.sessionID, { requestID: observation.requestID, calls: new Map() });
      return;
    }
    if (!previous || previous.requestID !== observation.requestID) return;
    if (observation.kind === "withdraw") {
      this.clearPreviews(observation.sessionID);
      return;
    }
    previous.calls.set(observation.callID, observation);
    this.publishPreview(observation.sessionID, observation.callID);
  }

  dispose() {
    for (const sessionID of this.previews.keys()) this.clearPreviews(sessionID);
    this.tools.clear();
  }

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
        if (this.options.threads.syncCreatedNative) await this.options.threads.syncCreatedNative(sessionID);
        else await this.options.threads.syncNative(sessionID);
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
          displayLabel: null,
        });
        this.broadcastThreadStatus(identity.threadId, { activeFlags: [], type: "active" });
        this.broadcastTurn("turn/started", identity.threadId, turn);
        return;
      }
      case "session.execution.started": {
        if (!this.options.threads.acceptExecutionEvent(sessionID, event.durable.seq)) return;
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
          displayLabel: null,
        });
        this.broadcastThreadStatus(active.threadId, { activeFlags: [], type: "active" });
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
          field: "reasoningSummary",
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
          ...previous,
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
          ...previous,
          input: event.data.input,
          name: previous?.name ?? "unknown",
          startedAt: previous?.startedAt ?? event.created,
        });
        await this.recordTool(sessionID, event.data.id, "inProgress", event.created);
        return;
      }
      case "session.tool.progress": {
        const previous = this.getTool(sessionID, event.data.id);
        if (previous) {
          previous.metadata = event.data.metadata;
          await this.recordTool(sessionID, event.data.id, "inProgress", event.created);
        }
        return;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const previous = this.getTool(sessionID, event.data.id);
        const active = previous?.active ?? await this.active(sessionID);
        const metadata = event.data.metadata ?? previous?.metadata;
        const succeeded = event.type === "session.tool.success"
          && !(metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.error === true);
        await this.options.transcript.recordItem({
          ...active,
          source: openCodeItemSource(event.data.id),
          item: {
            ...this.toolItem(event.data.id, previous, succeeded ? "completed" : "failed"),
            ...(metadata !== undefined ? { metadata } : {}),
            contentItems: openCodeToolContentItems(
              event.data.content,
              event.type === "session.tool.failed" ? event.data.error : undefined,
            ),
            success: succeeded,
            durationMs: previous ? Math.max(0, event.created - previous.startedAt) : null,
          },
          lifecycle: "completed",
          observedAt: event.created,
        });
        this.previews.get(sessionID)?.calls.delete(event.data.id);
        this.deleteTool(sessionID, event.data.id);
        return;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        if (!this.options.threads.acceptExecutionEvent(sessionID, event.durable.seq)) return;
        const startingTurn = this.options.threads.currentTurn(sessionID);
        const intentVersion = this.options.threads.executionIntentVersion(sessionID);
        this.clearPreviews(sessionID);
        const requestedInterrupt = this.options.threads.consumeRequestedInterrupt?.(sessionID) ?? false;
        const identity = await this.options.threads.syncNative(sessionID);
        if (event.type === "session.execution.succeeded" && identity.hasPendingSteers) return;
        if (startingTurn && this.options.threads.currentTurn(sessionID)?.turnId !== startingTurn.turnId) return;
        if (identity.latestTurnId && identity.latestTurnId !== this.options.threads.currentTurn(sessionID)?.turnId) return;
        const turn = await this.options.threads.latestTurn(identity.threadId);
        if (!turn) return;
        if (startingTurn && (turn.id !== startingTurn.turnId
          || this.options.threads.currentTurn(sessionID)?.turnId !== startingTurn.turnId)) return;
        this.options.threads.markExecutionSettled(sessionID);
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
        const lifecycle = await this.options.observe({
          activity: null,
          lifecycle: {
            threadId: identity.threadId,
            event: {
              kind: "turnCompleted",
              turnId: WorkbenchTurnIdSchema.parse(turn.id),
              status,
            },
          },
          displayLabel: null,
        });
        this.broadcastTurn("turn/completed", identity.threadId, { ...turn, status });
        this.broadcastThreadStatus(identity.threadId, { type: "idle" });
        await this.options.threads.completeExecution({
          sessionID, eventID: event.id, turnId: WorkbenchTurnIdSchema.parse(turn.id),
          status, lifecycle: lifecycle || null, intentVersion,
        });
      }
    }
  }

  private broadcastThreadStatus(threadId: WorkbenchThreadId, status: ThreadStatus) {
    this.options.broadcast?.({ method: "thread/status/changed", params: { threadId, status } });
  }

  private broadcastTurn(method: "turn/started" | "turn/completed", threadId: WorkbenchThreadId, turn: Turn) {
    this.options.broadcast?.({ method, params: { threadId, turn } });
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
    const state = this.getTool(sessionID, id);
    const active = state?.active ?? await this.active(sessionID);
    const itemId = await this.options.transcript.recordItem({
      ...active,
      source: openCodeItemSource(id),
      item: this.toolItem(id, this.getTool(sessionID, id), status),
      lifecycle: "streaming",
      observedAt,
    });
    if (state) {
      state.active = active;
      state.itemId = itemId;
    }
    this.publishPreview(sessionID, id);
  }

  private publishPreview(sessionID: string, id: string) {
    const preview = this.previews.get(sessionID)?.calls.get(id);
    const tool = this.getTool(sessionID, id);
    if (!preview || !tool?.active || !tool.itemId || preview.tool !== tool.name) return;
    this.options.transcript.previewToolPatch?.({ ...tool.active, itemId: tool.itemId, files: preview.files });
  }

  private clearPreviews(sessionID: string) {
    const previous = this.previews.get(sessionID);
    for (const id of previous?.calls.keys() ?? []) {
      const tool = this.getTool(sessionID, id);
      if (tool?.active && tool.itemId) {
        this.options.transcript.previewToolPatch?.({ ...tool.active, itemId: tool.itemId, files: [] });
      }
    }
    this.previews.delete(sessionID);
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
      ...(state?.metadata !== undefined ? { metadata: state.metadata } : {}),
      ...(state?.name === "execute" ? { toolCallGroupId: id } : {}),
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
    return { type: "reasoning", id: "pending", summary: [text], content: [] };
  }

}
