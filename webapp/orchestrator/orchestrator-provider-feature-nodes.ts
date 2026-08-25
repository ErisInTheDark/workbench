/*
 * Exports:
 * - CODEX_APP_SERVER_FEATURE_NODE_ID: Codex provider parent id. Keywords: codex, app-server, id.
 * - CODEX_BRIDGE_FEATURE_NODE_ID: Codex bridge dependant id. Keywords: codex, bridge, id.
 * - OPENCODE_APP_SERVER_FEATURE_NODE_ID: OpenCode provider parent id. Keywords: opencode, app-server, id.
 * - OPENCODE_BRIDGE_FEATURE_NODE_ID: OpenCode bridge dependant id. Keywords: opencode, bridge, id.
 * - createOrchestratorProviderFeatureNodes: declare provider-owned destructive parents and stateful bridge dependants. Keywords: codex, opencode, handoff, scope.
 */
import CodexAppServer from "./CodexAppServer";
import CodexStdioBridge from "./CodexStdioBridge";
import type { OrchestratorFeatureNodeDefinition } from "./OrchestratorFeatureHost";
import { OpenCodeBridge, type OpenCodeBridgeState } from "./opencode-bridge";
import OpenCodeAppServer from "./OpenCodeAppServer";
import type {
  OrchestratorCodexAppServerRuntime,
  OrchestratorFeatureContext,
  OrchestratorFeatures,
  OrchestratorProviderNotification,
} from "./orchestrator-feature-registry";
import { PROCESS_FEATURE_NODE_ID } from "./orchestrator-runtime-feature-nodes";
import { WORKBENCH_CORE_FEATURE_NODE_ID } from "./WorkbenchCoreFeature";

export const CODEX_APP_SERVER_FEATURE_NODE_ID = "codex-app-server";
export const CODEX_BRIDGE_FEATURE_NODE_ID = "codex-bridge";
export const OPENCODE_APP_SERVER_FEATURE_NODE_ID = "opencode-app-server";
export const OPENCODE_BRIDGE_FEATURE_NODE_ID = "opencode-bridge";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

class CodexAppServerNodeRuntime implements OrchestratorCodexAppServerRuntime {
  readonly appServer: CodexAppServer;
  private acceptingMessages = true;
  private bridge: CodexStdioBridge | null = null;
  private handoffGate: ReturnType<typeof deferred> | null = null;
  private messageTail = Promise.resolve();

  constructor(private readonly context: OrchestratorFeatureContext) {
    this.appServer = new CodexAppServer({
      ...context.codexAppServerOptions,
      onFatalExit: (reason) => {
        this.acceptingMessages = false;
        this.releaseHandoffGate();
        this.bridge?.beginStopping();
        context.onCodexFatalExit(reason, this.bridge);
      },
      onMessage: (message) => this.enqueueMessage(message),
    });
  }

  attachBridge(bridge: CodexStdioBridge) {
    this.bridge = bridge;
    this.acceptingMessages = true;
    this.handoffGate?.resolve();
    this.handoffGate = null;
  }

  async detachBridge(bridge: CodexStdioBridge) {
    if (this.bridge !== bridge) throw new Error("Codex bridge handoff targeted a bridge that its app-server parent does not own.");
    const gate = deferred();
    this.handoffGate = gate;
    try {
      await this.messageTail.catch(() => undefined);
      const state = await bridge.detachForReload();
      this.bridge = null;
      return state;
    } catch (error) {
      gate.resolve();
      if (this.handoffGate === gate) this.handoffGate = null;
      throw error;
    }
  }

  isTransitioning() {
    return this.handoffGate !== null;
  }

  isAvailable() {
    return this.acceptingMessages && this.bridge !== null;
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

export function createOrchestratorProviderFeatureNodes(
  context: OrchestratorFeatureContext,
): readonly OrchestratorFeatureNodeDefinition<OrchestratorFeatureContext, OrchestratorFeatures, OrchestratorProviderNotification>[] {
  return [
    {
      create: () => {
        const runtime = new CodexAppServerNodeRuntime(context);
        let detached = false;
        return {
          detachForReload: async () => {
            await runtime.stop();
            detached = true;
          },
          dispose: async () => { if (!detached) await runtime.stop(); },
          features: { codexAppServer: runtime },
          start: () => undefined,
        };
      },
      dependencies: [PROCESS_FEATURE_NODE_ID],
      featureKeys: ["codexAppServer"],
      id: CODEX_APP_SERVER_FEATURE_NODE_ID,
      lifecycle: "handoff",
      scope: "harness:codex",
    },
    {
      create: (_current, build) => {
        const parent = build.get("codexAppServer");
        const bridge = new CodexStdioBridge(context.createCodexBridgeOptions(parent.appServer, build.handoffState as Parameters<OrchestratorFeatureContext["createCodexBridgeOptions"]>[1]));
        parent.attachBridge(bridge);
        let activated = build.mode === "initial";
        let detached = false;
        return {
          activate: async () => {
            activated = true;
            await context.onCodexBridgeActivated(build.isReplacing(CODEX_APP_SERVER_FEATURE_NODE_ID));
          },
          detachForReload: async (replacement) => {
            const restartingAppServer = replacement.isReplacing(CODEX_APP_SERVER_FEATURE_NODE_ID);
            context.onCodexBridgeUnavailable(restartingAppServer);
            const state = await parent.detachBridge(bridge);
            detached = true;
            return state;
          },
          dispose: async () => {
            if (detached) return;
            if (activated) await bridge.dispose();
            else await bridge.detachForReload();
          },
          features: { codexBridge: bridge },
          start: async () => {
            const restartingAppServer = build.isReplacing(CODEX_APP_SERVER_FEATURE_NODE_ID);
            if (build.mode !== "initial") await context.onCodexBridgeReady(bridge);
            build.get("codexHealth").start({ armed: true });
          },
        };
      },
      dependencies: [WORKBENCH_CORE_FEATURE_NODE_ID, CODEX_APP_SERVER_FEATURE_NODE_ID],
      featureKeys: ["codexBridge"],
      id: CODEX_BRIDGE_FEATURE_NODE_ID,
      lifecycle: "handoff",
      scope: "server:codex",
    },
    {
      create: () => {
        const appServer = new OpenCodeAppServer(context.openCodeAppServerOptions);
        let detached = false;
        return {
          detachForReload: async () => {
            await appServer.stop();
            detached = true;
          },
          dispose: async () => { if (!detached) await appServer.stop(); },
          features: { openCodeAppServer: appServer },
          start: () => undefined,
        };
      },
      dependencies: [PROCESS_FEATURE_NODE_ID],
      featureKeys: ["openCodeAppServer"],
      id: OPENCODE_APP_SERVER_FEATURE_NODE_ID,
      lifecycle: "handoff",
      scope: "harness:opencode",
    },
    {
      create: (_current, build) => {
        const modules = build.get("modules");
        const bridge = new OpenCodeBridge({
          ...context.openCodeBridgeOptions,
          appServer: build.get("openCodeAppServer"),
          getReloadableModules: () => modules,
          initialState: build.handoffState as OpenCodeBridgeState | undefined,
        });
        let activated = build.mode === "initial";
        let detached = false;
        return {
          activate: () => { activated = true; },
          detachForReload: async () => {
            const state = await bridge.detachForReload();
            detached = true;
            return state;
          },
          dispose: async () => {
            if (detached) return;
            if (activated) await bridge.stop();
            else await bridge.detachForReload();
          },
          features: { openCodeBridge: bridge },
          start: () => undefined,
        };
      },
      dependencies: [WORKBENCH_CORE_FEATURE_NODE_ID, OPENCODE_APP_SERVER_FEATURE_NODE_ID],
      featureKeys: ["openCodeBridge"],
      id: OPENCODE_BRIDGE_FEATURE_NODE_ID,
      lifecycle: "handoff",
      scope: "server:opencode",
    },
  ];
}
