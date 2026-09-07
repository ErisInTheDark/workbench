/*
 * Exports:
 * - default WorkbenchWebSocketNode: own reloadable browser WebSocket routing, request timing, and aggregate event-stream health with state handoff. Keywords: websocket, stream, reload, handoff, diagnostics.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchWebSocketRequestController, { type WorkbenchWebSocketRequestControllerState } from "./WorkbenchWebSocketRequestController";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [],
  create: (_context, build) => {
    const controller = new WorkbenchWebSocketRequestController({
      harnesses: build.get("harnesses"),
      identities: { threads: build.get("threadIdentity"), items: build.get("transcriptIdentity") },
      daemonRequests: build.get("daemonRequests"),
      initialState: build.handoffState as WorkbenchWebSocketRequestControllerState | undefined,
      reload: build.get("reloadController"),
      stats: build.get("stats"),
      threadState: build.get("threadState").controller,
      transcript: build.get("transcript"),
      transcriptShadowLog: build.get("transcriptShadowLog"),
    });
    let detached = false;
    return {
      detachForReload: () => {
        detached = true;
        return controller.detachForReload();
      },
      dispose: () => { if (!detached) controller.dispose(); },
      registrations: { webSocketRequests: controller },
      start: async () => await controller.start(),
    };
  },
  description: "Reload browser WebSocket routing, request diagnostics, and aggregate event-stream health without restarting sockets.",
  lifecycle: "handoff",
  provides: ["webSocketRequests"],
  requires: ["daemonRequests", "harnesses", "reloadController", "stats", "threadState", "threadIdentity", "transcriptIdentity", "transcript", "transcriptShadowLog"],
  safeAll: true,
  scope: "server:websocket",
  sources: [
    "shared/workbench/orchestrator-health.ts",
    "shared/workbench/websocket-stream.ts",
    "daemon/orchestrator/WorkbenchWebSocketNode.ts",
    "daemon/orchestrator/websocket-log-format.ts",
    "daemon/orchestrator/WorkbenchWebSocketRequestController.ts",
    "daemon/orchestrator/thread-identity-provider-mapping.ts",
    "daemon/orchestrator/thread-identity-transcript-mapping.ts",
    "daemon/orchestrator/thread-identity-workbench-mapping.ts",
    "daemon/orchestrator/WorkbenchWebSocketStreamController.ts",
  ].join("\n"),
});
