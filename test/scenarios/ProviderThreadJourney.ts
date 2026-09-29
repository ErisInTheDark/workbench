/*
 * Exports:
 * - SharedRuntimeCheckpoints: reopen one clone only after every selected provider reaches each checkpoint.
 * - default ProviderThreadJourney: own one provider thread's transcript, questionnaire, tool-gate and turn evidence.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { WorkbenchComposerProfile, WorkbenchPendingUserInputRequest } from "../../shared/types";
import type { TranscriptTextUpdate } from "../../shared/workbench/transcript/thread-transcript-stream";
import { projectWorkbenchTranscript } from "../../shared/workbench/transcript/workbench-transcript-projection";
import IsolatedWorkbench from "./IsolatedWorkbench";

export class SharedRuntimeCheckpoints {
  private phase = 0;
  private waiting: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private failed: Error | null = null;

  constructor(
    private readonly runtime: IsolatedWorkbench,
    private readonly profiles: readonly WorkbenchComposerProfile[],
    private readonly prefixProof: string,
    private readonly participants: number,
  ) {}

  async reopen(phase: number) {
    if (this.failed) throw this.failed;
    if (phase !== this.phase) throw new Error("Provider journeys reached cold reopen out of order.");
    if (this.waiting.length >= this.participants) throw new Error("Shared reopen already has every provider.");
    return await new Promise<void>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      if (this.waiting.length !== this.participants) return;
      void (async () => {
        try {
          await this.runtime.stop();
          if (this.failed) throw this.failed;
          await this.runtime.start(this.profiles, this.prefixProof);
          if (this.failed) throw this.failed;
          this.phase++;
          for (const participant of this.waiting.splice(0)) participant.resolve();
        } catch (error) {
          this.failed ??= error instanceof Error ? error : new Error("Shared runtime reopen failed.");
          for (const participant of this.waiting.splice(0)) participant.reject(this.failed);
        }
      })();
    });
  }

  fail(error: Error) {
    if (this.failed) return;
    this.failed = error;
    if (this.waiting.length < this.participants) {
      for (const participant of this.waiting.splice(0)) participant.reject(error);
    }
  }
}

export default class ProviderThreadJourney {
  readonly subscriptionId = `thread-${randomUUID()}`;
  readonly liveText = new Map<string, TranscriptTextUpdate>();

  constructor(
    private readonly runtime: IsolatedWorkbench,
    readonly provider: "codex" | "opencode" | "claude",
    readonly projectId: string,
    readonly threadId: string,
    private readonly signal: AbortSignal,
  ) {}

  subscribe() {
    return this.runtime.transcripts.subscribe(
      { threadId: this.threadId, turnLimit: 20, subscriptionId: this.subscriptionId },
      () => assert.fail("The thread scenario must use the incremental SQLite transcript protocol"),
      update => {
        if (update.kind !== "text" || update.field !== "agentMessageText") return;
        const previous = this.liveText.get(update.itemId);
        this.liveText.set(update.itemId, {
          ...update,
          text: update.append ? `${previous?.text ?? ""}${update.text}` : update.text,
        });
      },
    );
  }

  async waitForFact<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
    return await this.runtime.waitForFact(read, ready, this.signal);
  }

  async durable() {
    const snapshot = await this.waitForFact(
      () => this.runtime.transcripts.read({ threadId: this.threadId, turnLimit: 30 }),
      value => value !== null,
    );
    assert.ok(snapshot, "The provider turn must be durable in SQLite");
    const projected = projectWorkbenchTranscript(snapshot);
    assert.ok(projected.success);
    return projected.data;
  }

  async waitHeldTool(turnId: string, proof: string) {
    await this.waitForFact(() => this.durable(), projection => {
      const turn = projection.turns.find(candidate => candidate.id === turnId);
      if (!turn) return false;
      const tool = turn.items.find(item =>
        ["commandExecution", "mcpToolCall", "dynamicToolCall"].includes(item.type)
        && JSON.stringify(item).includes(proof));
      if (tool) {
        assert.ok(tool.type === "commandExecution" || tool.type === "mcpToolCall"
          || tool.type === "dynamicToolCall");
        assert.equal(tool.status, "inProgress", "Shell gate settled before scenario released it");
        return true;
      }
      assert.ok(!turn.items.some(item =>
        (item.type === "mcpToolCall" || item.type === "dynamicToolCall")
        && item.tool === "request_user_input" && item.status === "inProgress"),
      "Provider requested user input before starting the shell gate");
      assert.equal(turn.status, "inProgress", `Turn ended before starting the shell gate: ${JSON.stringify(turn.items.map(item => ({
        type: item.type,
        tool: "tool" in item ? item.tool : undefined,
        status: "status" in item ? item.status : undefined,
      })))}`);
      return false;
    });
  }

  async submit(text: string, intent: "newTurn" | "continue" = "continue") {
    const result = await this.runtime.daemon.threads.message({
      threadId: this.threadId, clientMessageId: randomUUID(), intent,
      input: [{ type: "text", text, text_elements: [] }], context: { workflowIds: [] },
    });
    assert.equal(result.kind, "started");
    assert.ok(result.kind === "started");
    return result.turn.id;
  }

  async waitTurn(turnId: string, status: "completed" | "interrupted" = "completed") {
    return await this.waitForFact(() => this.durable(), projection => {
      const turn = projection.turns.find(candidate => candidate.id === turnId);
      if (turn && ["completed", "failed", "interrupted"].includes(turn.status) && turn.status !== status) {
        throw new Error(`${this.provider} turn ${turnId} settled as ${turn.status}; expected ${status}.`);
      }
      return turn?.status === status;
    });
  }

  async readRetainedQuestions() {
    const state = await this.runtime.projectThreads(this.projectId, this.signal);
    return state.rows.flatMap(({ entry }) =>
      entry.entryKind !== "draft" && entry.identity.threadId === this.threadId && entry.pendingQuestionnaire ? [{
        ...entry.pendingQuestionnaire,
        ...entry.identity,
        itemId: entry.pendingQuestionnaire.itemId ?? null,
        turnId: entry.pendingQuestionnaire.turnId ?? null,
      }] : []);
  }

  async pending(id: string) {
    const questions = await this.waitForFact(
      async () => ({
        questions: (await this.runtime.daemon.questionnaires.pending()).data
          .filter(question => question.harness === this.provider && question.threadId === this.threadId),
        latest: (await this.durable()).turns.at(-1),
      }),
      value => {
        const found = value.questions.some(question => question.turnId
          && question.request.questions.some(entry => entry.id === id));
        if (!found && value.latest && value.latest.status !== "inProgress") {
          throw new Error(`${this.provider} turn settled as ${value.latest.status} before question ${id}.`);
        }
        return found;
      },
    );
    const found = questions.questions.find(question => question.turnId
      && question.request.questions.some(entry => entry.id === id));
    assert.ok(found, `Question ${id} must be pending on ${this.provider}.`);
    return found;
  }

  answer(question: WorkbenchPendingUserInputRequest, id: string, proof: string, supplementalInput?: string) {
    return this.runtime.daemon.threads.questionnaire.respond({
      projectId: this.projectId,
      threadId: this.threadId,
      requestKey: question.requestKey,
      response: { answers: { [id]: { answers: [proof] } } },
      ...(supplementalInput ? {
        supplementalInput: [{ type: "text" as const, text: supplementalInput, text_elements: [] }],
      } : {}),
    });
  }

  unsubscribe() {
    return this.runtime.transcripts.unsubscribe({ subscriptionId: this.subscriptionId });
  }
}
