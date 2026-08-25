/*
 * Exports:
 * - default CodexBridgeNode: own reloadable Codex bridge code while preserving the parent app-server process. Keywords: codex, bridge, handoff.
 */
import CodexStdioBridge from "./CodexStdioBridge";
import type { CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [],
  create: (context, build) => {
    const parent = build.get("codexAppServer");
    const bridge = new CodexStdioBridge(context.createCodexBridgeOptions(parent.appServer, build.handoffState as CodexStdioBridgeReloadState | undefined));
    parent.attachBridge(bridge);
    let activated = build.mode === "initial";
    let detached = false;
    return {
      activate: async () => {
        activated = true;
        await context.onCodexBridgeActivated(build.isReplacing("harness:codex"));
      },
      detachForReload: async (replacement) => {
        const restartingAppServer = replacement.isReplacing("harness:codex");
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
      registrations: { codexBridge: bridge },
      start: async () => {
        if (build.mode !== "initial") await context.onCodexBridgeReady(bridge);
        build.get("codexHealth").start({ armed: true });
      },
    };
  },
  description: "Reload Codex bridge code without restarting the Codex app-server.",
  lifecycle: "handoff",
  provides: ["codexBridge"],
  requires: ["codexAppServer", "codexHealth"],
  safeAll: true,
  scope: "server:codex",
  sources: [
    "webapp/orchestrator/CodexBridgeNode.ts",
    "webapp/orchestrator/CodexStdioBridge.ts",
    "webapp/orchestrator/CodexBridgeTransitionController.ts",
    "webapp/orchestrator/CodexRecoverySupervisor.ts",
    "webapp/orchestrator/codex-transcript-*.ts",
    "webapp/orchestrator/copilot-bridge.ts",
    "webapp/orchestrator/copilot-thread-state.ts",
  ].join("\n"),
});
