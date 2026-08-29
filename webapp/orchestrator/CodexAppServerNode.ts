/*
 * Exports:
 * - default CodexAppServerNode: own the stable Codex app-server process and declare its bridge child. Keywords: codex, app-server, parent.
 */
import CodexBridgeNode from "./CodexBridgeNode";
import CodexAppServer from "./CodexAppServer";
import type CodexStdioBridge from "./CodexStdioBridge";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorCodexAppServerRuntime, OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

class CodexAppServerRuntime implements OrchestratorCodexAppServerRuntime {
  readonly appServer: CodexAppServer;
  private acceptingMessages = true;
  private bridge: CodexStdioBridge | null = null;
  private handoffGate: ReturnType<typeof deferred> | null = null;
  private messageTail = Promise.resolve();

  constructor(private readonly context: OrchestratorProcessContext) {
    this.appServer = new CodexAppServer({
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
    const gate = deferred();
    this.handoffGate = gate;
    try {
      await this.messageTail.catch(() => undefined);
      const state = await bridge.detachForReload(options);
      this.bridge = null;
      return state;
    } catch (error) {
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

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "cli",
  children: [CodexBridgeNode],
  create: (context) => {
    const runtime = new CodexAppServerRuntime(context);
    let detached = false;
    return {
      detachForReload: async () => {
        await runtime.stop();
        detached = true;
      },
      dispose: async () => { if (!detached) await runtime.stop(); },
      registrations: { codexAppServer: runtime },
      start: () => undefined,
    };
  },
  description: "Restart the Codex app-server process and rebuild its bridge.",
  lifecycle: "handoff",
  provides: ["codexAppServer"],
  requires: [],
  safeAll: false,
  scope: "harness:codex",
  sources: [
    "webapp/orchestrator/CodexAppServerNode.ts",
    "webapp/orchestrator/CodexAppServer.ts",
  ].join("\n"),
});
