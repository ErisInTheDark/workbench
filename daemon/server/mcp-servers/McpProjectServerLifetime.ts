/*
 * Exports:
 * - McpProjectServerLifetimePorts: working-thread seed, lifecycle changes by project, and the activity and release its servers learn of.
 * - default McpProjectServerLifetime: track each project's working threads, report each project a thread starts working in, and
 *   release its project-scoped MCP servers when its last working thread stops; a server first used while none works is released at
 *   that project's next such stop.
 */

export interface McpProjectServerLifetimePorts {
  /** Threads working now, with their projects. */
  readWorking(): Promise<readonly { projectId: string; threadId: string }[]>;
  /** Every published thread lifecycle change, as whether that thread of that project is now working. */
  subscribe(listener: (projectId: string, threadId: string, working: boolean) => void): () => void;
  release(projectId: string): void;
  /** A thread of this project started working, or was working at start. */
  active(projectId: string): void;
  warn(message: string): void;
}

export default class McpProjectServerLifetime {
  readonly #working = new Map<string, Set<string>>();
  /** Threads changed while the seed read ran; their events are newer than the seed. */
  #observedDuringSeed: Set<string> | null = new Set();
  readonly #unsubscribe: () => void;

  constructor(private readonly ports: McpProjectServerLifetimePorts) {
    this.#unsubscribe = ports.subscribe((projectId, threadId, working) => {
      this.#observedDuringSeed?.add(threadId);
      this.#set(projectId, threadId, working);
    });
  }

  async start() {
    try {
      for (const { projectId, threadId } of await this.ports.readWorking()) {
        if (!this.#observedDuringSeed?.has(threadId)) this.#set(projectId, threadId, true);
      }
    } catch (error) {
      this.ports.warn(`Working threads could not be read for MCP project servers: ${error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`);
    } finally {
      this.#observedDuringSeed = null;
    }
  }

  dispose() {
    this.#unsubscribe();
  }

  #set(projectId: string, threadId: string, working: boolean) {
    const threads = this.#working.get(projectId);
    if (working) {
      if (threads) threads.add(threadId);
      else this.#working.set(projectId, new Set([threadId]));
      this.ports.active(projectId);
      return;
    }
    // Every idle transition with nobody else working releases, so a server opened while nothing worked still closes.
    threads?.delete(threadId);
    if (threads?.size) return;
    this.#working.delete(projectId);
    this.ports.release(projectId);
  }
}
