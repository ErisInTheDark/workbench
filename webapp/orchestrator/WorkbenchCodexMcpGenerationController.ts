/*
 * Exports:
 * - default WorkbenchCodexMcpGenerationController: own process MCP generation, coalesced Codex refresh, and failure-safe freshness admission. Keywords: MCP, generation, refresh, lifecycle.
 */
import { randomUUID } from "node:crypto";

interface RefreshFlight {
  generation: string;
  promise: Promise<void>;
}

export default class WorkbenchCodexMcpGenerationController {
  private readonly epoch: string;
  private counter = 0;
  private refreshedGeneration: string | null = null;
  private refreshFlight: RefreshFlight | null = null;

  constructor(epoch: string = randomUUID()) {
    this.epoch = epoch;
  }

  get generation() {
    return `${this.epoch}:${this.counter}`;
  }

  bump() {
    this.counter += 1;
    return this.generation;
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
