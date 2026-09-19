/*
 * Exports:
 * - CodexAppServerRuntimeOptions: inject the stable Codex app-server process for lifecycle tests.
 * - CodexAppServerRuntimePorts: native process configuration and failure notification.
 * - default CodexAppServerRuntime: own stable app-server ingress and two-phase bridge handoff.
 */
import CodexAppServer, { type CodexAppServerOptions } from "./CodexAppServer";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { DaemonCodexAppServerRuntime } from "./daemon-runtime-objects";
import type { ReloadableNodeHandoff } from "../../shared/reload/ReloadableNode";

export interface CodexAppServerRuntimeOptions {
  createAppServer?: (options: CodexAppServerOptions) => CodexAppServer;
  previousAppServer?: CodexAppServer;
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

  constructor(
    ports: CodexAppServerRuntimePorts,
    { createAppServer = (options) => new CodexAppServer(options), previousAppServer }: CodexAppServerRuntimeOptions = {},
  ) {
    this.ports = ports;
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
      this.handoffGate ??= deferred();
      bridge.expireForReload();
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

  private enqueueMessage(message: unknown) {
    if (!this.acceptingMessages) return;
    this.messageTail = this.messageTail.catch(() => undefined).then(async () => {
      await this.handoffGate?.promise;
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
      try {
        await Promise.race([work, cancelled]);
      } catch (error) {
        if (error !== signal.reason) throw error;
      } finally {
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
