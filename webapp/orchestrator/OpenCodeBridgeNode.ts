/*
 * Exports:
 * - default OpenCodeBridgeNode: own reloadable OpenCode bridge code while preserving the parent app-server process. Keywords: opencode, bridge, handoff.
 */
import { OpenCodeBridge, type OpenCodeBridgeState } from "./opencode-bridge";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [],
  create: (context, build) => {
    const harnesses = build.get("harnesses");
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
      activate: async () => {
        activated = true;
        await harnesses.recoverAvailable("opencode");
      },
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
      registrations: { openCodeBridge: bridge },
      start: () => undefined,
    };
  },
  description: "Reload OpenCode bridge code without restarting the OpenCode app-server.",
  lifecycle: "handoff",
  provides: ["openCodeBridge"],
  requires: ["harnesses", "modules", "openCodeAppServer"],
  safeAll: true,
  scope: "server:opencode",
  sources: [
    "webapp/orchestrator/OpenCodeBridgeNode.ts",
    "webapp/orchestrator/opencode-bridge.ts",
    "webapp/orchestrator/opencode-live-thread-state.ts",
    "webapp/orchestrator/opencode-thread-state.ts",
    "webapp/orchestrator/opencode-workbench-instructions.ts",
    "webapp/lib/workbench/thread/workbench-thread-page.ts",
  ].join("\n"),
});
