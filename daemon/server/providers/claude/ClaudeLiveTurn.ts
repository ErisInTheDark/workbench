/*
 * Exports:
 * - ClaudePromptQueue: streaming SDK input that stays open for steers until the turn closes.
 * - claudePrompt: build one SDK user message from text or content blocks with an optional delivery uuid.
 * - ClaudeLiveTurnOptions: collaborators one live turn needs.
 * - default ClaudeLiveTurn: own one Claude query from start to its single settlement, including steer and context delivery and context usage; it signals when billing usage changed.
 */
import type { Query, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { ProjectId, WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import type { ThreadTokenUsage } from "workbench-shared/workbench/thread/thread-context-usage";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type {
  WorkbenchProviderObservation, WorkbenchTranscriptNotification,
} from "workbench-shared/workbench/provider/provider-observation";
import type ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";
import { claudeTokenBreakdown } from "./ClaudeTranscriptAdapter";
import { prefixClaudePrompt, type ClaudePromptContent } from "./claude-prompt-content";

type Breakdown = ThreadTokenUsage["total"];
type Settlement = "completed" | "failed" | "interrupted";

export class ClaudePromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(value: SDKUserMessage) {
    if (this.closed) throw new Error("Claude prompt queue has closed.");
    this.values.push(value);
    this.wake?.();
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed || this.values.length) {
      if (this.values.length) yield this.values.shift()!;
      else await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = null;
    }
  }
}

export function claudePrompt(
  content: ClaudePromptContent, options: { synthetic?: boolean; uuid?: string } = {},
): SDKUserMessage {
  return {
    type: "user", message: { role: "user", content },
    parent_tool_use_id: null, uuid: (options.uuid ?? randomUUID()) as SDKUserMessage["uuid"] & string,
    ...(options.synthetic ? { isSynthetic: true } : {}),
  };
}

const EMPTY: Breakdown = {
  cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens: 0,
  outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
};

function addBreakdowns(left: Breakdown, right: Breakdown): Breakdown {
  return {
    cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

/** The main model carries the conversation context; helper models only add side calls. */
function mainContextWindow(result: SDKResultMessage) {
  const [usage] = Object.values(result.modelUsage ?? {}).sort((left, right) =>
    (right.inputTokens + right.cacheReadInputTokens + right.cacheCreationInputTokens)
    - (left.inputTokens + left.cacheReadInputTokens + left.cacheCreationInputTokens));
  return usage && usage.contextWindow > 0 ? usage.contextWindow : null;
}

export interface ClaudeLiveTurnOptions {
  query: Query;
  queue: ClaudePromptQueue;
  scope: string;
  cwd: string;
  /** Lifecycle observations name their project so they apply even before thread state loads it. */
  projectId: ProjectId;
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
  workingStatusInPrompt: boolean;
  usage: ThreadTokenUsage | null;
  /** The window Workbench launched Claude with; it outranks windows Claude reports. Null keeps the reported window. */
  contextWindow: number | null;
  transcript: Pick<ClaudeTranscriptAdapter,
    "recordStreamEvent" | "recordAssistant" | "recordNativeToolResults" | "recordCompaction"
    | "recordContextUsage" | "recordSteer" | "settleTurn">;
  /** Claude's session log gained billed calls; billing usage is derived from that log, not from this turn. */
  usageChanged(): void;
  observe(facts: WorkbenchProviderObservation): Promise<unknown>;
  broadcast(notification: WorkbenchTranscriptNotification): void;
  readTurn(): Promise<Turn | null>;
  processExit(): Promise<void>;
  stderr(): string;
  /** Release process-scoped resources and detach from the live registry before settlement is published. */
  release(): Promise<void>;
}

export default class ClaudeLiveTurn {
  readonly scope: string;
  readonly cwd: string;
  readonly threadId: WorkbenchThreadId;
  readonly turnId: WorkbenchTurnId;
  readonly workingStatusInPrompt: boolean;
  private readonly undelivered = new Map<string, WorkbenchSteerHistoryEntry>();
  /** Input that arrives while start() publishes acceptance; null once the first prompt is admitted. */
  private beforePrompt: { context: string[]; steers: SDKUserMessage[] } | null = { context: [], steers: [] };
  private stopped = false;
  private settled = false;
  private closing: Promise<void> | null = null;
  private task: Promise<void> = Promise.resolve();
  private total: Breakdown;
  private last: Breakdown | null;
  private contextWindow: number | null;

  constructor(private readonly options: ClaudeLiveTurnOptions) {
    this.scope = options.scope;
    this.cwd = options.cwd;
    this.threadId = options.threadId;
    this.turnId = options.turnId;
    this.workingStatusInPrompt = options.workingStatusInPrompt;
    this.total = options.usage?.total ?? EMPTY;
    this.last = options.usage?.last ?? null;
    this.contextWindow = options.contextWindow ?? options.usage?.modelContextWindow ?? null;
  }

  /**
   * Accept the turn's lifecycle, then admit its first prompt. Acceptance must precede the prompt: Claude can
   * request questionnaires within one model round, and those bind to the accepted turn. Context that
   * acceptance injects meanwhile, such as a working-status notice, prefixes the prompt; steers follow it.
   * The returned task settles exactly once.
   */
  async start(content: ClaudePromptContent) {
    let warning: string | null = null;
    try {
      await this.options.observe({
        projectId: this.options.projectId,
        activity: { kind: "turnStarted", threadId: this.threadId, startedAt: Date.now() },
        lifecycle: { threadId: this.threadId, event: { kind: "acceptedIntent", turnId: this.turnId } },
        displayLabel: null,
      });
      this.options.broadcast({ method: "thread/status/changed", params: { threadId: this.threadId, status: { type: "active", activeFlags: [] } } });
      const turn = await this.options.readTurn();
      if (turn) this.options.broadcast({ method: "turn/started", params: { threadId: this.threadId, turn } });
    } catch (error) {
      warning = `Turn started, but its working state could not be published: ${
        error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`;
      console.warn("[claude]", warning);
    }
    const deferred = this.beforePrompt;
    this.beforePrompt = null;
    this.options.queue.push(claudePrompt(deferred.context.length
      ? prefixClaudePrompt(deferred.context.join("\n\n"), content) : content));
    for (const steer of deferred.steers) this.options.queue.push(steer);
    this.task = this.run();
    return { task: this.task, warning };
  }

  /** False once the query is closing; later messages belong to a new turn. */
  get acceptingInput() {
    return this.closing === null && !this.stopped;
  }

  /** Resolve after this turn released its process and published its settlement. */
  whenSettled() {
    return this.task.then(() => undefined, () => undefined);
  }

  /** Queue a steer; it is recorded only when Claude acknowledges folding it into the conversation. */
  steer(entry: WorkbenchSteerHistoryEntry, content: ClaudePromptContent) {
    if (!entry.itemId) throw new Error("Claude steer has no item identity.");
    const message = claudePrompt(content, { uuid: entry.itemId });
    if (this.beforePrompt) this.beforePrompt.steers.push(message);
    else this.options.queue.push(message);
    this.undelivered.set(entry.itemId, entry);
  }

  inject(text: string) {
    if (this.beforePrompt) this.beforePrompt.context.push(text);
    else this.options.queue.push(claudePrompt(text, { synthetic: true }));
  }

  /** Inject non-text context, such as a screenshot, as its own synthetic message; it follows the prompt if accepted early. */
  injectContent(content: ClaudePromptContent) {
    if (!this.acceptingInput) throw new Error("Claude turn is closing and cannot accept more context.");
    const message = claudePrompt(content, { synthetic: true });
    if (this.beforePrompt) this.beforePrompt.steers.push(message);
    else this.options.queue.push(message);
  }

  async interrupt() {
    this.stopped = true;
    try {
      await this.options.query.interrupt();
    } finally {
      this.options.queue.close();
      this.options.query.close();
      await this.task;
      await this.finish("interrupted");
    }
  }

  private async run() {
    let status: Exclude<Settlement, "interrupted"> = "failed";
    try {
      status = await this.consume();
    } catch (error) {
      if (!this.stopped) {
        console.error("[claude] query failed",
          error instanceof Error ? error.message.slice(0, 500) : "unknown failure",
          this.options.stderr().slice(-1000));
      }
    } finally {
      await this.close();
    }
    if (!this.stopped) await this.finish(status);
  }

  private async consume(): Promise<Exclude<Settlement, "interrupted">> {
    const { transcript } = this.options;
    for await (const message of this.options.query as AsyncIterable<SDKMessage>) {
      if (message.type === "stream_event") {
        await transcript.recordStreamEvent(this.threadId, this.turnId, message);
      } else if (message.type === "assistant") {
        await transcript.recordAssistant(this.threadId, this.turnId, message);
        if (!message.parent_tool_use_id && message.message.usage) {
          this.last = claudeTokenBreakdown(message.message.usage);
          await this.recordUsage();
        }
      } else if (message.type === "user") {
        if ("isReplay" in message && message.isReplay) await this.deliver(message.uuid);
        else await transcript.recordNativeToolResults(this.threadId, message);
      } else if (message.type === "system" && message.subtype === "compact_boundary") {
        await transcript.recordCompaction(this.threadId, this.turnId, message);
      } else if (message.type === "result") {
        for (const uuid of message.user_message_uuids ?? []) await this.deliver(uuid);
        this.total = addBreakdowns(this.total, claudeTokenBreakdown(message.usage));
        this.contextWindow = this.options.contextWindow ?? mainContextWindow(message) ?? this.contextWindow;
        await this.recordUsage();
        this.options.usageChanged();
        // Steers Claude has not consumed yet run as follow-up results inside this Workbench turn. Other queued
        // context, such as a late working-status notice, does not earn another model turn.
        if (!this.stopped && this.undelivered.size > 0) continue;
        return message.subtype === "success" && !message.is_error ? "completed" : "failed";
      }
    }
    return "failed";
  }

  private async deliver(uuid: string) {
    const entry = this.undelivered.get(uuid);
    if (!entry) return;
    this.undelivered.delete(uuid);
    await this.options.transcript.recordSteer({
      ...entry, status: "sent", resolvedAt: Date.now(), canonicalItemId: entry.itemId ?? null,
    });
  }

  /** Persist for later reads and publish live; clients only learn current usage from the notification. */
  private async recordUsage() {
    if (!this.last) return;
    const tokenUsage = { last: this.last, total: this.total, modelContextWindow: this.contextWindow };
    await this.options.transcript.recordContextUsage(this.threadId, tokenUsage);
    this.options.broadcast({
      method: "thread/tokenUsage/updated", params: { threadId: this.threadId, turnId: this.turnId, tokenUsage },
    });
  }

  private close() {
    this.closing ??= (async () => {
      this.options.queue.close();
      this.options.query.close();
      await this.options.processExit();
      await this.options.release();
    })();
    return this.closing;
  }

  /** The only settlement path: leftover steers, the transcript turn, thread lifecycle, and live notifications. */
  private async finish(status: Settlement) {
    if (this.settled) return;
    this.settled = true;
    const now = Date.now();
    for (const entry of this.undelivered.values()) {
      await this.options.transcript.recordSteer({
        ...entry, resolvedAt: now,
        status: status === "failed" ? "failed" : "interrupted",
        error: status === "failed" ? "The Claude turn failed before this steer was delivered."
          : status === "completed" ? "The Claude turn ended before this steer was delivered." : null,
      });
    }
    this.undelivered.clear();
    await this.options.transcript.settleTurn(this.turnId, status);
    // Interrupted and failed turns never reach a result but may still have billed calls.
    this.options.usageChanged();
    await this.options.observe({
      projectId: this.options.projectId, activity: null, displayLabel: null,
      lifecycle: { threadId: this.threadId, event: { kind: "turnCompleted", turnId: this.turnId, status } },
    });
    const turn = await this.options.readTurn();
    if (turn) this.options.broadcast({ method: "turn/completed", params: { threadId: this.threadId, turn } });
    this.options.broadcast({ method: "thread/status/changed", params: { threadId: this.threadId, status: { type: "idle" } } });
  }
}
