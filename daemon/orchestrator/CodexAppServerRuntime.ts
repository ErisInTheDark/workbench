/*
 * Exports:
 * - CodexAppServerRuntimeOptions: inject the stable Codex app-server process for lifecycle tests. Keywords: codex, app-server, runtime, test.
 * - default CodexAppServerRuntime: own stable app-server ingress and two-phase bridge handoff. Keywords: codex, app-server, bridge, reload, handoff.
 */
import CodexAppServer, { type CodexAppServerOptions } from "./CodexAppServer";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorCodexAppServerRuntime } from "./orchestrator-runtime-objects";
import type { ReloadableNodeHandoff } from "../../shared/reload/ReloadableNode";

export interface CodexAppServerRuntimeOptions {
  createAppServer?: (options: CodexAppServerOptions) => CodexAppServer;
  previousAppServer?: CodexAppServer;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

export default class CodexAppServerRuntime implements OrchestratorCodexAppServerRuntime {
  readonly appServer: CodexAppServer;
  private acceptingMessages = true;
  private bridge: CodexStdioBridge | null = null;
  private readonly context: OrchestratorProcessContext;
  private handoffGate: ReturnType<typeof deferred> | null = null;
  private messageTail = Promise.resolve();
  private messageGeneration = new AbortController();

  constructor(
    context: OrchestratorProcessContext,
    { createAppServer = (options) => new CodexAppServer(options), previousAppServer }: CodexAppServerRuntimeOptions = {},
  ) {
    this.context = context;
    this.appServer = createAppServer({
      ...context.codexAppServerOptions,
      previousAppServer,
      onFatalExit: (reason) => {
        this.acceptingMessages = false;
        this.releaseHandoffGate();
        this.bridge?.beginStopping(reason);
        context.onCodexFatalExit(reason, this.bridge);
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

  async stop() {
    this.acceptingMessages = false;
    this.messageGeneration.abort(new Error("Codex app-server retired."));
    this.releaseHandoffGate();
    this.bridge = null;
    const results = await Promise.allSettled([this.appServer.retirePrevious(), this.appServer.stopAsync()]);
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
          this.context.codexAppServerOptions.logError?.("codex-bridge", `retired upstream handler failed: ${String(error).slice(0, 500)}`);
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
      this.context.codexAppServerOptions.logError?.("codex-bridge", `failed to handle upstream message: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
    });
  }

  private releaseHandoffGate() {
    this.handoffGate?.resolve();
    this.handoffGate = null;
  }
}
