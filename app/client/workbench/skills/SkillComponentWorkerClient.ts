/*
 * Exports:
 * - SkillComponentRender: a validated tree and the public images it names, as the worker returns it.
 * - SkillComponentEvaluator: one session's components: load its bundles, render requests, close.
 * - SkillComponentWorkerRequest/SkillComponentWorkerResponse: the worker's message protocol.
 * - default SkillComponentWorkerClient: one component worker shared by many sessions, started on first use and
 *   recreated (every open session's bundles reloaded) after it crashes.
 */
import frontendJavaScriptGeneration from "workbench-shared/frontend-generation";
import type { SkillComponentBundle, SkillComponentRequest } from "workbench-shared/workbench/skills/skill-component-contract";
import type { ThreadComponentNode } from "workbench-shared/workbench/thread/thread-component-tree";

export interface SkillComponentRender {
  tree: ThreadComponentNode;
  imageUrls: string[];
}

export interface SkillComponentEvaluator {
  /** Replaces the session's components; renders already sent finish against whatever they reach. */
  load(bundles: readonly SkillComponentBundle[]): void;
  render(request: SkillComponentRequest): Promise<SkillComponentRender>;
  close(): void;
}

export type SkillComponentWorkerRequest =
  | { type: "load"; session: number; bundles: readonly SkillComponentBundle[] }
  | { type: "render"; id: number; session: number; request: SkillComponentRequest }
  | { type: "close"; session: number };

export type SkillComponentWorkerResponse =
  | { id: number; render: SkillComponentRender }
  | { id: number; error: string };

type Pending = { resolve(render: SkillComponentRender): void; reject(error: Error): void };

export default class SkillComponentWorkerClient {
  #worker: Worker | null = null;
  #nextId = 0;
  #nextSession = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #sessions = new Map<number, readonly SkillComponentBundle[]>();

  constructor(private readonly url = `/assets/skill-components.js?v=${frontendJavaScriptGeneration}`) {}

  open(): SkillComponentEvaluator {
    const session = this.#nextSession += 1;
    let closed = false;
    return {
      load: bundles => {
        if (closed) return;
        this.#sessions.set(session, bundles);
        // A new worker replays every session's bundles, this one included.
        if (this.#worker) this.#worker.postMessage({ type: "load", session, bundles } satisfies SkillComponentWorkerRequest);
        else this.#connect();
      },
      render: request => {
        if (closed) return Promise.reject(new Error("Skill components were closed."));
        const id = this.#nextId += 1;
        return new Promise<SkillComponentRender>((resolve, reject) => {
          this.#pending.set(id, { resolve, reject });
          this.#connect().postMessage({ type: "render", id, session, request } satisfies SkillComponentWorkerRequest);
        });
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.#sessions.delete(session);
        this.#worker?.postMessage({ type: "close", session } satisfies SkillComponentWorkerRequest);
      },
    };
  }

  #connect(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(this.url, { type: "module" });
    worker.onmessage = (event: MessageEvent<SkillComponentWorkerResponse>) => {
      const entry = this.#pending.get(event.data.id);
      if (!entry) return;
      this.#pending.delete(event.data.id);
      if ("render" in event.data) entry.resolve(event.data.render);
      else entry.reject(new Error(event.data.error));
    };
    worker.onerror = event => {
      event.preventDefault();
      this.#fail(`Skill components stopped: ${event.message || "worker error"}`);
    };
    this.#worker = worker;
    for (const [session, bundles] of this.#sessions) worker.postMessage({ type: "load", session, bundles } satisfies SkillComponentWorkerRequest);
    return worker;
  }

  #fail(reason: string) {
    this.#worker?.terminate();
    this.#worker = null;
    for (const entry of this.#pending.values()) entry.reject(new Error(reason));
    this.#pending.clear();
  }
}
