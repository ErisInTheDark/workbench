/*
 * Keywords: websocket, stream, reload, handoff, diagnostics.
 * Exports:
 * - default WorkbenchWebSocketNode: own reloadable browser WebSocket routing, traffic logs, request timing and stream health.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchWebSocketRequestController, { type WorkbenchWebSocketRequestControllerState } from "./WorkbenchWebSocketRequestController";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [],
  create: (context, build) => {
    const controller = new WorkbenchWebSocketRequestController({
      harnesses: build.get("harnesses"),
      identities: { threads: build.get("threadIdentity"), items: build.get("transcriptIdentity") },
      daemonRequests: build.get("daemonRequests"),
      initialState: build.handoffState as WorkbenchWebSocketRequestControllerState | undefined,
      reload: build.get("reloadController"),
      reportDelivery: context.reportWebSocketDelivery,
      stats: build.get("stats"),
      threadState: build.get("threadState").controller,
      transcript: build.get("transcript"),
      transcriptShadowLog: build.get("transcriptShadowLog"),
    });
    controller.suspend();
    return {
      afterCommit: () => {
        void controller.resumeAfterFailedReload().catch((error: unknown) => controller.reportSendFailure({ method: "WebSocket startup" }, error));
      },
      beginHandoff: () => ({
        waitForIdle: async () => {},
        expire: () => controller.suspend(),
        detach: () => controller.detachForReload(),
        resume: () => controller.resumeAfterFailedReload(),
        commit: () => controller.dispose(),
      }),
      detachForReload: () => controller.detachForReload(),
      dispose: () => controller.dispose(),
      registrations: { webSocketRequests: controller },
      start: async () => {},
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
    "daemon/orchestrator/WorkbenchWebSocketEventLog.ts",
    "daemon/orchestrator/thread-identity-provider-mapping.ts",
    "daemon/orchestrator/thread-identity-transcript-mapping.ts",
    "daemon/orchestrator/thread-identity-workbench-mapping.ts",
    "daemon/orchestrator/WorkbenchWebSocketStreamController.ts",
  ].join("\n"),
});
