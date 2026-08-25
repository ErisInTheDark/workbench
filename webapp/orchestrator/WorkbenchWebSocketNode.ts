/*
 * Exports:
 * - default WorkbenchWebSocketNode: own reloadable browser WebSocket routing and pending-request telemetry with state handoff. Keywords: websocket, reload, handoff, diagnostics.
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
      threadState: build.get("threadState").controller,
    });
    let detached = false;
    return {
      detachForReload: () => {
        detached = true;
        return controller.detachForReload();
      },
      dispose: () => { if (!detached) controller.dispose(); },
      registrations: { webSocketRequests: controller },
      start: () => undefined,
    };
  },
  description: "Reload browser WebSocket routing and request diagnostics without restarting sockets.",
  lifecycle: "handoff",
  provides: ["webSocketRequests"],
  requires: ["harnesses", "threadState"],
  safeAll: true,
  scope: "server:websocket",
  sources: [
    "webapp/orchestrator/WorkbenchWebSocketNode.ts",
    "webapp/orchestrator/WorkbenchWebSocketRequestController.ts",
  ].join("\n"),
});
