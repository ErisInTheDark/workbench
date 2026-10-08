/*
 * Exports:
 * - ClaudePromptQueue: streaming SDK input that stays open for steers until its session closes.
 * - spawnTrackedClaude: spawn one Claude Code process and report its exit.
 * - ClaudeSessionRead: one consumer read from a session's buffered output.
 * - ClaudeSession: the process surface a live turn drives.
 * - ENDED_CLAUDE_SESSION: inert session for a turn whose process is already gone.
 * - ClaudeSessionHandlers: bridge-generation collaborators that native hooks reach through the host.
 * - ClaudeSessionLaunch: one live process launch request.
 * - ClaudeProcessSession: one live Claude Code process, its input queue, buffered output, and config view.
 * - default ClaudeSessionHost: own live Claude Code processes across bridge reloads and route their hooks to the attached bridge.
 */
import {
  query, type Options, type Query, type SDKMessage, type SDKUserMessage, type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { lowerAgentProcessPriority } from "../../process-helpers";
import type { WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type { WorkbenchFileClaimCheckResult } from "../../lib/workbench/file-claim-check";
import ClaudeConfigView from "./ClaudeConfigView";

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

export function spawnTrackedClaude(options: SpawnOptions, onExit: (exit: Promise<void>) => void) {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd, env: options.env, signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  lowerAgentProcessPriority(child);
  onExit(new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  }));
  return child;
}

export type ClaudeSessionRead = { kind: "message"; message: SDKMessage } | { kind: "end" } | { kind: "paused" };

export interface ClaudeSession {
  push(message: SDKUserMessage): void;
  /** Next buffered output; an aborted signal returns `paused` without consuming anything. */
  read(signal: AbortSignal): Promise<ClaudeSessionRead>;
  interrupt(): Promise<void>;
  /** Close input and the query, wait for the process to exit, then release process resources. */
  close(): Promise<void>;
  stderr(): string;
}

export const ENDED_CLAUDE_SESSION: ClaudeSession = {
  push: () => { throw new Error("Claude process has ended."); },
  read: async () => ({ kind: "end" }),
  interrupt: async () => undefined,
  close: async () => undefined,
  stderr: () => "",
};

export interface ClaudeSessionHandlers {
  checkFileClaims(request: { cwd: string; threadId: WorkbenchThreadId; paths: string[] }): Promise<WorkbenchFileClaimCheckResult>;
  recordNativeToolDenial(turnId: WorkbenchTurnId, toolUseId: string): void;
}

export interface ClaudeSessionLaunch {
  scope: string;
  captureStderr: boolean;
  /** SDK options for this process; the host owns process spawning and stderr capture. */
  options(viewEnv: NodeJS.ProcessEnv | undefined): Omit<Options, "spawnClaudeCodeProcess" | "stderr">;
}

export class ClaudeProcessSession implements ClaudeSession {
  private readonly buffered: SDKMessage[] = [];
  private readonly waiters = new Set<() => void>();
  private failure: { error: unknown } | null = null;
  private ended = false;
  private closing: Promise<void> | null = null;

  constructor(
    readonly scope: string,
    private readonly sdkQuery: Query,
    private readonly queue: ClaudePromptQueue,
    private readonly runtime: { exit(): Promise<void>; stderr(): string; release(): Promise<void> },
  ) {
    void this.pump();
  }

  /** Output is buffered here so a reloading consumer neither loses nor double-reads a message. */
  private async pump() {
    try {
      for await (const message of this.sdkQuery as AsyncIterable<SDKMessage>) {
        this.buffered.push(message);
        this.notify();
      }
    } catch (error) {
      this.failure = { error };
    } finally {
      this.ended = true;
      this.notify();
    }
  }

  private notify() {
    for (const wake of [...this.waiters]) wake();
  }

  push(message: SDKUserMessage) {
    this.queue.push(message);
  }

  async read(signal: AbortSignal): Promise<ClaudeSessionRead> {
    for (;;) {
      if (signal.aborted) return { kind: "paused" };
      const message = this.buffered.shift();
      if (message) return { kind: "message", message };
      if (this.failure) {
        const { error } = this.failure;
        this.failure = null;
        throw error;
      }
      if (this.ended) return { kind: "end" };
      await new Promise<void>(resolve => {
        const wake = () => {
          this.waiters.delete(wake);
          signal.removeEventListener("abort", wake);
          resolve();
        };
        this.waiters.add(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
  }

  async interrupt() {
    await this.sdkQuery.interrupt();
  }

  close() {
    this.closing ??= (async () => {
      this.queue.close();
      this.sdkQuery.close();
      await this.runtime.exit();
      await this.runtime.release();
    })();
    return this.closing;
  }

  stderr() {
    return this.runtime.stderr();
  }
}

export default class ClaudeSessionHost {
  readonly viewsRoot: string | null;
  private readonly sessions = new Map<string, ClaudeProcessSession>();
  private readonly waiting = new Set<() => void>();
  private readonly calls = new Set<Promise<unknown>>();
  private handlers: ClaudeSessionHandlers | null = null;
  private disposed = false;

  constructor(private readonly options: {
    /** Root for per-process sanitized Claude config views; null runs Claude against the daemon's config. */
    viewsRoot: string | null;
    createQuery?: typeof query;
  }) {
    this.viewsRoot = options.viewsRoot;
  }

  hasPendingWork() { return this.sessions.size > 0; }

  get(scope: string) { return this.sessions.get(scope); }

  /** One bridge generation at a time; the returned detach waits for its hook calls in flight. */
  attach(handlers: ClaudeSessionHandlers) {
    if (this.disposed) throw new Error("Claude sessions were disposed.");
    if (this.handlers) throw new Error("Claude sessions already have an attached bridge.");
    this.handlers = handlers;
    for (const wake of [...this.waiting]) wake();
    let attached = true;
    return async () => {
      if (!attached) return;
      attached = false;
      if (this.handlers === handlers) this.handlers = null;
      while (this.calls.size) await Promise.allSettled([...this.calls]);
    };
  }

  /** Run a hook collaborator on the attached bridge, waiting across a bridge reload. */
  async call<T>(operation: (handlers: ClaudeSessionHandlers) => Promise<T>): Promise<T> {
    while (!this.handlers) {
      if (this.disposed) throw new Error("Claude sessions were disposed.");
      await new Promise<void>(resolve => {
        const wake = () => { this.waiting.delete(wake); resolve(); };
        this.waiting.add(wake);
      });
    }
    const running = operation(this.handlers);
    this.calls.add(running);
    try { return await running; }
    finally { this.calls.delete(running); }
  }

  async launch(input: ClaudeSessionLaunch) {
    if (this.disposed) throw new Error("Claude sessions were disposed.");
    if (this.sessions.has(input.scope)) throw new Error("Claude session scope is already live.");
    const view = this.viewsRoot ? await ClaudeConfigView.create(this.viewsRoot) : null;
    let options: ReturnType<ClaudeSessionLaunch["options"]>;
    try {
      options = input.options(view?.env);
    } catch (error) {
      await view?.dispose();
      throw error;
    }
    return await this.start(input.scope, input.captureStderr, options, view);
  }

  /**
   * Sessions outlive the bridge generation that launched them. Every closure here shares one context, so none of
   * them may see the launch request: its `options` builder belongs to that generation and would pin all of it.
   */
  private async start(
    scope: string,
    captureStderr: boolean,
    sdkOptions: ReturnType<ClaudeSessionLaunch["options"]>,
    view: ClaudeConfigView | null,
  ) {
    const queue = new ClaudePromptQueue();
    let exit: Promise<void> | null = null;
    let stderr = "";
    let session: ClaudeProcessSession;
    try {
      const sdkQuery = (this.options.createQuery ?? query)({
        prompt: queue,
        options: {
          ...sdkOptions,
          spawnClaudeCodeProcess: options => spawnTrackedClaude(options, value => { exit = value; }),
          ...(captureStderr ? { stderr: (data: string) => { stderr = (stderr + data).slice(-2000); } } : {}),
        },
      });
      session = new ClaudeProcessSession(scope, sdkQuery, queue, {
        exit: () => exit ?? Promise.resolve(),
        stderr: () => stderr,
        release: async () => {
          if (this.sessions.get(scope) === session) this.sessions.delete(scope);
          await view?.dispose();
        },
      });
    } catch (error) {
      await view?.dispose();
      throw error;
    }
    this.sessions.set(scope, session);
    return session;
  }

  /** Harness replacement or daemon exit: stop every remaining process without publishing turn state. */
  async dispose() {
    this.disposed = true;
    for (const wake of [...this.waiting]) wake();
    await Promise.all([...this.sessions.values()].map(session => session.close()));
  }
}
