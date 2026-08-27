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
      initialState: build.handoffState as WorkbenchWebSocketRequestControllerState | undefined,
      reload: build.get("reloadController"),
      threadState: build.get("threadState").controller,
      transcript: build.get("transcript"),
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
  requires: ["harnesses", "reloadController", "threadState", "transcript"],
  safeAll: true,
  scope: "server:websocket",
  sources: [
    "webapp/lib/workbench/websocket-stream.ts",
    "webapp/orchestrator/WorkbenchWebSocketNode.ts",
    "webapp/orchestrator/WorkbenchWebSocketRequestController.ts",
    "webapp/orchestrator/WorkbenchWebSocketStreamController.ts",
  ].join("\n"),
});
