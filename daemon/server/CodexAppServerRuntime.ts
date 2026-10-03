/*
 * Exports:
 * - CodexAppServerRuntimeOptions: inject the stable Codex app-server process and stall-diagnostic timers for tests.
 * - CodexAppServerRuntimePorts: native process configuration and failure notification.
 * - default CodexAppServerRuntime: own stable app-server ingress, two-phase bridge handoff, and stalled-ingress logs.
 */
import CodexAppServer, { type CodexAppServerOptions } from "./CodexAppServer";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { DaemonCodexAppServerRuntime } from "./daemon-runtime-objects";
import type { ReloadableNodeHandoff } from "../../shared/reload/ReloadableNode";

export interface CodexAppServerRuntimeOptions {
  createAppServer?: (options: CodexAppServerOptions) => CodexAppServer;
  previousAppServer?: CodexAppServer;
  /** Clock and scheduler for stall diagnostics. */
  timers?: {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  };
}

/** Upstream messages run one at a time, so one stuck message stalls every later Codex response. */
const STALL_WARNING_MS = 10_000;
const STALL_REPEAT_MS = 30_000;

function describeUpstreamMessage(message: unknown) {
  const record = message && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : null;
  const bounded = (value: unknown) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 80);
  if (typeof record?.method === "string") {
    return record.id === undefined ? `notification ${bounded(record.method)}` : `request ${bounded(record.method)} id=${bounded(record.id)}`;
  }
  return record && "id" in record ? `response id=${bounded(record.id)}` : "message";
}

export interface CodexAppServerRuntimePorts {
  appServer: Omit<CodexAppServerOptions, "onFatalExit" | "onMessage" | "previousAppServer">;
  onFatalExit(reason: string): void;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

export default class CodexAppServerRuntime implements DaemonCodexAppServerRuntime {
  readonly appServer: CodexAppServer;
  private acceptingMessages = true;
  private bridge: CodexStdioBridge | null = null;
  private readonly ports: CodexAppServerRuntimePorts;
  private handoffGate: ReturnType<typeof deferred> | null = null;
  private messageTail = Promise.resolve();
  private messageGeneration = new AbortController();
  private previousRetirement: ReturnType<typeof deferred> | null;
  private previousRetirementAttempt: Promise<void> | null = null;
  private readonly timers: NonNullable<CodexAppServerRuntimeOptions["timers"]>;

  constructor(
    ports: CodexAppServerRuntimePorts,
    {
      createAppServer = (options) => new CodexAppServer(options), previousAppServer,
      timers = { now: Date.now, setTimeout, clearTimeout },
    }: CodexAppServerRuntimeOptions = {},
  ) {
    this.ports = ports;
    this.timers = timers;
    this.previousRetirement = previousAppServer ? deferred() : null;
    this.appServer = createAppServer({
      ...ports.appServer,
      previousAppServer,
      onFatalExit: (reason) => {
        this.acceptingMessages = false;
        this.releaseHandoffGate();
        this.bridge?.beginStopping(reason);
        ports.onFatalExit(reason);
      },
      onMessage: (message) => this.enqueueMessage(message),
    });
  }

  attachBridge(bridge: CodexStdioBridge, { publish = true }: { publish?: boolean } = {}) {
    this.bridge = bridge;
    this.acceptingMessages = true;
    if (publish) {
      if (this.messageGeneration.signal.aborted) this.messageGeneration = new AbortController();
      this.releaseHandoffGate();
    }
  }

  deactivateBridge(bridge: CodexStdioBridge) {
    if (this.bridge !== bridge) return;
    this.handoffGate ??= deferred();
    this.bridge = null;
  }

  beginBridgeHandoff(
    bridge: CodexStdioBridge,
    options?: Parameters<CodexStdioBridge["detachForReload"]>[0],
  ): ReloadableNodeHandoff {
    if (this.bridge !== bridge) throw new Error("Codex bridge handoff targeted a bridge that its app-server parent does not own.");
    const messages = this.messageTail;
    const expire = () => {
      bridge.expireForReload();
      // Once detached, the runtime's gate and handler generation belong to the replacement bridge.
      if (this.bridge !== bridge) return;
      this.handoffGate ??= deferred();
      this.messageGeneration.abort(new Error("Codex upstream handler retired."));
    };
    return {
      waitForIdle: async () => {
        await bridge.prepareForReload(options);
        await messages;
        await bridge.waitForIdle();
      },
      expire,
      detach: async () => {
        expire();
        const state = await bridge.detachForReload(options);
        if (this.bridge === bridge) this.bridge = null;
        return state;
      },
      resume: () => {
        bridge.resumeAfterReloadFailure();
        this.attachBridge(bridge);
      },
      commit: () => bridge.retireAfterHandoff(options),
    };
  }

  async detachBridge(bridge: CodexStdioBridge, options?: Parameters<CodexStdioBridge["detachForReload"]>[0]) {
    if (this.bridge !== bridge) throw new Error("Codex bridge handoff targeted a bridge that its app-server parent does not own.");
    await bridge.prepareForReload(options);
    if (this.bridge !== bridge) throw new Error("Codex bridge ownership changed while preparing handoff.");
    const gate = deferred();
    this.handoffGate = gate;
    try {
      await this.messageTail.catch(() => undefined);
      const state = await bridge.detachForReload(options);
      if (this.bridge === bridge) this.bridge = null;
      return state;
    } catch (error) {
      if (this.bridge === bridge) bridge.resumeAfterReloadFailure();
      gate.resolve();
      if (this.handoffGate === gate) this.handoffGate = null;
      throw error;
    }
  }

  isAvailable() {
    return this.acceptingMessages && this.bridge !== null;
  }

  isTransitioning() {
    return this.handoffGate !== null;
  }

  retirePrevious() {
    const retirement = this.previousRetirement;
    if (!retirement) return Promise.resolve();
    if (this.previousRetirementAttempt) return this.previousRetirementAttempt;
    const attempt = this.appServer.retirePrevious().then(() => {
      if (this.previousRetirement !== retirement) return;
      retirement.resolve();
      this.previousRetirement = null;
    }, (error: unknown) => {
      if (this.previousRetirement === retirement) {
        retirement.reject(error);
        this.previousRetirement = deferred();
      }
      throw error;
    }).finally(() => {
      if (this.previousRetirementAttempt === attempt) this.previousRetirementAttempt = null;
    });
    this.previousRetirementAttempt = attempt;
    return attempt;
  }

  waitUntilReady() {
    return this.previousRetirement?.promise ?? Promise.resolve();
  }

  async stop() {
    this.acceptingMessages = false;
    this.messageGeneration.abort(new Error("Codex app-server retired."));
    this.releaseHandoffGate();
    this.bridge = null;
    const retirePrevious = this.previousRetirement
      ? this.retirePrevious()
      : this.appServer.retirePrevious();
    const results = await Promise.allSettled([retirePrevious, this.appServer.stopAsync()]);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Codex runtime shutdown failed.");
  }

  /** Log while one stage stays stuck; the returned stop ends the watch. */
  private watchStall(stage: string) {
    const startedAt = this.timers.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const warn = () => {
      const seconds = ((this.timers.now() - startedAt) / 1_000).toFixed(1);
      this.ports.appServer.logError?.("codex-bridge", `${stage} still pending after ${seconds}s; later Codex responses are queued behind it.`);
      timer = this.timers.setTimeout(warn, STALL_REPEAT_MS);
    };
    timer = this.timers.setTimeout(warn, STALL_WARNING_MS);
    return () => {
      if (timer !== null) this.timers.clearTimeout(timer);
      timer = null;
    };
  }

  private enqueueMessage(message: unknown) {
    if (!this.acceptingMessages) return;
    this.messageTail = this.messageTail.catch(() => undefined).then(async () => {
      const label = describeUpstreamMessage(message);
      if (this.handoffGate) {
        const stopGateWatch = this.watchStall(`upstream ${label} waiting for the bridge handoff gate`);
        try { await this.handoffGate.promise; } finally { stopGateWatch(); }
      }
      if (!this.acceptingMessages) return;
      const bridge = this.bridge;
      if (!bridge) throw new Error("Codex app-server produced a message without an attached bridge owner.");
      const signal = this.messageGeneration.signal;
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      const work = bridge.handleUpstreamMessage(message).catch(error => {
        if (signal.aborted && error !== signal.reason) {
          this.ports.appServer.logError?.("codex-bridge", `retired upstream handler failed: ${String(error).slice(0, 500)}`);
        }
        throw error;
      });
      const stopHandlerWatch = this.watchStall(`upstream ${label} handler`);
      try {
        await Promise.race([work, cancelled]);
      } catch (error) {
        if (error !== signal.reason) throw error;
      } finally {
        stopHandlerWatch();
        signal.removeEventListener("abort", onAbort);
      }
    }).catch((error) => {
      this.ports.appServer.logError?.("codex-bridge", `failed to handle upstream message: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
    });
  }

  private releaseHandoffGate() {
    this.handoffGate?.resolve();
    this.handoffGate = null;
  }
}
