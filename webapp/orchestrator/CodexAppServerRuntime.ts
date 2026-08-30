/*
 * Exports:
 * - CodexAppServerRuntimeOptions: inject the stable Codex app-server process for lifecycle tests. Keywords: codex, app-server, runtime, test.
 * - default CodexAppServerRuntime: own stable app-server ingress and two-phase bridge handoff. Keywords: codex, app-server, bridge, reload, handoff.
 */
import CodexAppServer, { type CodexAppServerOptions } from "./CodexAppServer";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorCodexAppServerRuntime } from "./orchestrator-runtime-objects";

export interface CodexAppServerRuntimeOptions {
  createAppServer?: (options: CodexAppServerOptions) => CodexAppServer;
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

  constructor(
    context: OrchestratorProcessContext,
    { createAppServer = (options) => new CodexAppServer(options) }: CodexAppServerRuntimeOptions = {},
  ) {
    this.context = context;
    this.appServer = createAppServer({
      ...context.codexAppServerOptions,
      onFatalExit: (reason) => {
        this.acceptingMessages = false;
        this.releaseHandoffGate();
        this.bridge?.beginStopping(reason);
        context.onCodexFatalExit(reason, this.bridge);
      },
      onMessage: (message) => this.enqueueMessage(message),
    });
  }

  attachBridge(bridge: CodexStdioBridge) {
    this.bridge = bridge;
    this.acceptingMessages = true;
    this.releaseHandoffGate();
  }

  async detachBridge(bridge: CodexStdioBridge, options?: Parameters<CodexStdioBridge["detachForReload"]>[0]) {
    if (this.bridge !== bridge) throw new Error("Codex bridge handoff targeted a bridge that its app-server parent does not own.");
    await bridge.prepareForReload(options);
    const gate = deferred();
    this.handoffGate = gate;
    try {
      await this.messageTail.catch(() => undefined);
      const state = await bridge.detachForReload(options);
      this.bridge = null;
      return state;
    } catch (error) {
      bridge.resumeAfterReloadFailure();
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
    this.releaseHandoffGate();
    await this.messageTail.catch(() => undefined);
    await this.appServer.stopAsync();
    this.bridge = null;
  }

  private enqueueMessage(message: unknown) {
    if (!this.acceptingMessages) return;
    const arrivalGate = this.handoffGate?.promise;
    this.messageTail = this.messageTail.catch(() => undefined).then(async () => {
      await arrivalGate;
      if (!this.acceptingMessages) return;
      const bridge = this.bridge;
      if (!bridge) throw new Error("Codex app-server produced a message without an attached bridge owner.");
      await bridge.handleUpstreamMessage(message);
    }).catch((error) => {
      this.context.codexAppServerOptions.logError?.("codex-bridge", `failed to handle upstream message: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private releaseHandoffGate() {
    this.handoffGate?.resolve();
    this.handoffGate = null;
  }
}
