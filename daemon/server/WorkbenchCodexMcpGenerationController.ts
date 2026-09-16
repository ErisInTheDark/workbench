/*
 * Exports:
 * - default WorkbenchCodexMcpGenerationController: coalesce native MCP preparation for one Codex bridge and the current shared catalogue.
 */
import { randomUUID } from "node:crypto";

interface RefreshFlight {
  generation: string;
  promise: Promise<void>;
}

export default class WorkbenchCodexMcpGenerationController {
  private readonly epoch = randomUUID();
  private refreshedGeneration: string | null = null;
  private refreshFlight: RefreshFlight | null = null;

  constructor(private readonly readRevision: () => string) {}

  get generation() {
    return `${this.epoch}:${this.readRevision()}`;
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
    while (this.refreshFlight) {
      await this.refreshFlight.promise;
      if (this.refreshedGeneration === generation) return;
    }
    if (generation !== this.generation) return;
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
