/*
 * Exports:
 * - WorkbenchCodexMcpGenerationState: reload-handoff state for Codex MCP freshness. Keywords: MCP, generation, handoff.
 * - default WorkbenchCodexMcpGenerationController: own MCP generation, coalesced Codex refresh, and failure-safe freshness admission. Keywords: MCP, generation, refresh, lifecycle.
 */
import { randomUUID } from "node:crypto";

interface RefreshFlight {
  generation: string;
  promise: Promise<void>;
}

export interface WorkbenchCodexMcpGenerationState {
  counter: number;
  epoch: string;
  refreshedGeneration: string | null;
}

export default class WorkbenchCodexMcpGenerationController {
  private readonly epoch: string;
  private counter = 0;
  private refreshedGeneration: string | null = null;
  private refreshFlight: RefreshFlight | null = null;

  constructor(state: WorkbenchCodexMcpGenerationState | string = randomUUID()) {
    if (typeof state === "string") {
      this.epoch = state;
      return;
    }
    this.epoch = state.epoch;
    this.counter = state.counter;
    this.refreshedGeneration = state.refreshedGeneration;
  }

  get generation() {
    return `${this.epoch}:${this.counter}`;
  }

  bump() {
    this.counter += 1;
    return this.generation;
  }

  detachForReload(): WorkbenchCodexMcpGenerationState {
    if (this.refreshFlight) throw new Error("Codex MCP generation cannot detach while a refresh is active.");
    return {
      counter: this.counter,
      epoch: this.epoch,
      refreshedGeneration: this.refreshedGeneration,
    };
  }

  async prepare(threadGeneration: string | null, refresh: () => Promise<void>) {
    let observedThreadGeneration = threadGeneration;
    while (observedThreadGeneration !== this.generation) {
      const target = this.generation;
      await this.ensureRefreshed(target, refresh);
      if (target === this.generation) return target;
      observedThreadGeneration = target;
    }
    return observedThreadGeneration;
  }

  private async ensureRefreshed(generation: string, refresh: () => Promise<void>) {
    if (this.refreshedGeneration === generation) return;
    if (this.refreshFlight) {
      await this.refreshFlight.promise;
      if (this.refreshedGeneration === generation) return;
    }
    const promise = refresh().then(() => {
      this.refreshedGeneration = generation;
    });
    this.refreshFlight = { generation, promise };
    try {
      await promise;
    } finally {
      if (this.refreshFlight?.promise === promise) this.refreshFlight = null;
    }
  }
}
