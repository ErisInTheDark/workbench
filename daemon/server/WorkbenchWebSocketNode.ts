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
      repo: build.get("repo"),
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
      workspace: {
        installationUpdate: build.get("installationUpdate"),
        catalogue: build.get("projectCatalog"),
        identities: threadIdentity,
        threads: threadState,
        projects: build.get("projectSnapshot"),
        stats: build.get("stats"),
        workingTree: build.get("workingTree"),
        accountLimits: build.get("accountLimits"),
        runtime: build.get("threadRuntime"),
        summaries: build.get("threadSummaries"),
        vis: build.get("vis"),
      },
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
  requires: ["voice", "repo", "daemonRequests", "harnesses", "reloadController", "stats", "threadState", "threadActions", "threadIdentity", "transcriptIdentity", "transcript", "projectCatalog", "projectSnapshot", "installationUpdate", "workingTree", "accountLimits", "threadRuntime", "threadSummaries", "vis"],
  safeAll: true,
  scope: "server:websocket",
});
