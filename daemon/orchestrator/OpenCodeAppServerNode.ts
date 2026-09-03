/*
 * Exports:
 * - default OpenCodeAppServerNode: own the OpenCode app-server process and declare its bridge child. Keywords: opencode, app-server, parent.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import OpenCodeAppServer from "./OpenCodeAppServer";
import OpenCodeBridgeNode from "./OpenCodeBridgeNode";
import ReloadableNode from "./ReloadableNode";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "cli",
  children: [OpenCodeBridgeNode],
  create: (context) => {
    const appServer = new OpenCodeAppServer(context.openCodeAppServerOptions);
    let detached = false;
    return {
      detachForReload: async () => {
        await appServer.stop();
        detached = true;
      },
      dispose: async () => { if (!detached) await appServer.stop(); },
      registrations: { openCodeAppServer: appServer },
      start: () => undefined,
    };
  },
  description: "Restart the OpenCode app-server process and rebuild its bridge.",
  lifecycle: "handoff",
  provides: ["openCodeAppServer"],
  requires: [],
  safeAll: false,
  scope: "harness:opencode",
  sources: [
    "daemon/orchestrator/OpenCodeAppServerNode.ts",
    "daemon/orchestrator/OpenCodeAppServer.ts",
  ].join("\n"),
});
