/*
 * Exports:
 * - default WorkbenchWebSocketNode: own reloadable browser WebSocket routing, traffic logs, request timing and stream health.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchWebSocketRequestController, { type WorkbenchWebSocketRequestControllerState } from "./WorkbenchWebSocketRequestController";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [],
  create: (context, build) => {
    const threadIdentity = build.get("threadIdentity");
    const threadState = build.get("threadState").controller;
    const controller = new WorkbenchWebSocketRequestController({
      voice: build.get("voice"),
      harnesses: build.get("harnesses"),
      identities: { threads: threadIdentity, items: build.get("transcriptIdentity") },
      daemonRequests: build.get("daemonRequests"),
      threadActions: build.get("threadActions"),
      initialState: build.handoffState as WorkbenchWebSocketRequestControllerState | undefined,
      reload: build.get("reloadController"),
      reportDelivery: context.reportWebSocketDelivery,
      stats: build.get("stats"),
      threadState,
      transcript: build.get("transcript"),
    });
    controller.suspend();
    return {
      afterCommit: () => {
        void controller.resumeAfterFailedReload().catch((error: unknown) => controller.reportSendFailure({ method: "WebSocket startup" }, error));
      },
      beginHandoff: () => ({
        waitForIdle: () => build.get("voice").controller.clear(),
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
  requires: ["voice", "daemonRequests", "harnesses", "reloadController", "stats", "threadState", "threadActions", "threadIdentity", "transcriptIdentity", "transcript"],
  safeAll: true,
  scope: "server:websocket",
  sources: [
    "shared/workbench/daemon-health.ts",
    "shared/workbench/websocket-stream.ts",
    "daemon/server/WorkbenchWebSocketNode.ts",
    "daemon/server/websocket-log-format.ts",
    "daemon/server/WorkbenchWebSocketRequestController.ts",
    "daemon/server/WorkbenchWebSocketEventLog.ts",
    "daemon/server/thread-identity-workbench-mapping.ts",
    "daemon/server/WorkbenchWebSocketStreamController.ts",
  ].join("\n"),
});
