/*
 * Exports:
 * - default CodexAppServerNode: own the stable Codex app-server process and declare its bridge child. Keywords: codex, app-server, parent.
 */
import CodexBridgeNode from "./CodexBridgeNode";
import CodexAppServerRuntime from "./CodexAppServerRuntime";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";

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
    "daemon/orchestrator/CodexAppServerNode.ts",
    "daemon/orchestrator/CodexAppServerRuntime.ts",
    "daemon/orchestrator/CodexAppServer.ts",
  ].join("\n"),
});
