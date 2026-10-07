/*
 * Exports:
 * - default WorkbenchThreadContextRolloverController: own active-turn context rollover and held-message release.
 */
import type { WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptContextCompactionObservation } from "./database/transcript/workbench-transcript-types";
import type WorkbenchThreadAdmissionController from "./WorkbenchThreadAdmissionController";
import type { WorkbenchThreadAdmissionHold } from "./WorkbenchThreadAdmissionController";
import {
  WORKBENCH_CONTEXT_ROLLOVER_INSTRUCTION,
  WORKBENCH_CONTEXT_ROLLOVER_INSTRUCTION_KEY,
  shouldRequestContextRollover,
} from "workbench-shared/workbench/thread/thread-context-rollover";

interface RolloverIdentity {
  reference: string;
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
}

interface ActiveRollover extends RolloverIdentity {
  hold: WorkbenchThreadAdmissionHold;
  phase: "started" | "replacing";
}

export default class WorkbenchThreadContextRolloverController {
  private readonly active = new Map<WorkbenchThreadId, ActiveRollover>();
  private readonly directives = new Map<WorkbenchThreadId, {
    turnId: WorkbenchTurnId;
    request: Promise<void>;
  }>();
  private readonly lifetime = new AbortController();

  constructor(
    private readonly admission: Pick<WorkbenchThreadAdmissionController, "hold">,
    private readonly ports: {
      readSelectedCap(threadId: WorkbenchThreadId): Promise<number | null>;
      requestDirective(
        threadId: WorkbenchThreadId,
        turnId: WorkbenchTurnId,
        instruction: string,
        key: string,
      ): Promise<void>;
      record(observation: WorkbenchTranscriptContextCompactionObservation): Promise<void>;
      replace(input: { summary: string; threadId: WorkbenchThreadId; turnId: WorkbenchTurnId }): Promise<void>;
      now(): number;
      warn(message: string): void;
    },
  ) {}

  async observeUsage(input: { contextTokens: number; threadId: WorkbenchThreadId; turnId: WorkbenchTurnId }) {
    this.lifetime.signal.throwIfAborted();
    if (this.active.has(input.threadId)) return;
    const existing = this.directives.get(input.threadId);
    if (existing?.turnId === input.turnId) return await existing.request;
    const request = (async () => {
      const selectedCap = await this.ports.readSelectedCap(input.threadId);
      this.lifetime.signal.throwIfAborted();
      if (!shouldRequestContextRollover(input.contextTokens, selectedCap)) {
        if (this.directives.get(input.threadId)?.request === request) this.directives.delete(input.threadId);
        return;
      }
      await this.ports.requestDirective(
        input.threadId,
        input.turnId,
        WORKBENCH_CONTEXT_ROLLOVER_INSTRUCTION,
        WORKBENCH_CONTEXT_ROLLOVER_INSTRUCTION_KEY,
      );
    })();
    this.directives.set(input.threadId, { turnId: input.turnId, request });
    try {
      await request;
    } catch (error) {
      if (this.directives.get(input.threadId)?.request === request) this.directives.delete(input.threadId);
      const message = error instanceof Error ? error.message : String(error);
      this.ports.warn(`Context rollover directive admission failed: ${message.slice(0, 300)}`);
    }
  }

  async toolStarted(input: RolloverIdentity) {
    this.lifetime.signal.throwIfAborted();
    const current = this.active.get(input.threadId);
    if (current) {
      if (current.turnId === input.turnId && current.reference === input.reference) return;
      throw new Error("Thread context rollover has already started.");
    }
    const active: ActiveRollover = {
      ...input,
      hold: this.admission.hold(input.threadId),
      phase: "started",
    };
    this.active.set(input.threadId, active);
    try {
      await this.record(active, "started");
    } catch (error) {
      this.active.delete(input.threadId);
      active.hold.fail(error);
      throw error;
    }
  }

  async acceptSummary(input: { summary: string; threadId: WorkbenchThreadId; turnId: WorkbenchTurnId }) {
    this.lifetime.signal.throwIfAborted();
    const active = this.active.get(input.threadId);
    if (!active || active.turnId !== input.turnId) throw new Error("Thread context rollover has not started.");
    if (active.phase !== "started") throw new Error("Thread context rollover is already replacing its native session.");
    const summary = input.summary.trim();
    if (!summary) throw new Error("Thread context rollover summary must not be empty.");
    active.phase = "replacing";
    try {
      await this.ports.replace({
        summary,
        threadId: active.threadId,
        turnId: active.turnId,
      });
      await this.record(active, "completed");
      this.active.delete(active.threadId);
      active.hold.release();
    } catch (error) {
      await this.failActive(active, error);
      throw error;
    }
  }

  isActiveTool(input: RolloverIdentity) {
    const active = this.active.get(input.threadId);
    return active?.turnId === input.turnId && active.reference === input.reference;
  }

  async toolFailed(input: RolloverIdentity, error: unknown) {
    const active = this.exactActive(input);
    await this.failActive(active, error);
  }

  hasPendingWork() { return this.active.size > 0; }

  async dispose() {
    if (!this.lifetime.signal.aborted) this.lifetime.abort(new Error("Thread context rollover is reloading."));
    const active = [...this.active.values()];
    await Promise.all(active.map(entry => this.failActive(entry, this.lifetime.signal.reason)));
    this.directives.clear();
  }

  private exactActive(input: RolloverIdentity) {
    const active = this.active.get(input.threadId);
    if (!active || active.turnId !== input.turnId || active.reference !== input.reference) {
      throw new Error("Thread context rollover start does not match this native tool.");
    }
    return active;
  }

  private async failActive(active: ActiveRollover, error: unknown) {
    if (this.active.get(active.threadId) !== active) return;
    this.active.delete(active.threadId);
    try {
      await this.record(active, "failed");
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.ports.warn(`Context rollover failure could not be recorded: ${message.slice(0, 300)}`);
    } finally {
      active.hold.fail(error);
    }
  }

  private async record(active: ActiveRollover, phase: WorkbenchTranscriptContextCompactionObservation["phase"]) {
    await this.ports.record({
      kind: "contextCompaction",
      observedAt: this.ports.now(),
      phase,
      reference: active.reference,
      threadId: active.threadId,
      turnId: active.turnId,
    });
  }
}
