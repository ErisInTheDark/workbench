/*
 * Exports:
 * - default CodexLifecycleNode: supervise Codex above the process it replaces.
 */
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexAppServerNode from "./CodexAppServerNode";
import CodexBridgeNode from "./CodexBridgeNode";
import CodexLifecycleController from "./CodexLifecycleController";
import { log, logError } from "./process-helpers";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "cli",
  children: [CodexAppServerNode, CodexBridgeNode],
  create: (context, build) => {
    const controller = new CodexLifecycleController({
      isShuttingDown: () => context.isShuttingDown() || !build.lease.isCurrent(),
      log: message => log("codex-recovery", message),
      logError: message => logError("codex-recovery", message),
      recover: async () => {
        // This owner is outside the child closure. Never hold a child lease
        // while asking the host to replace that child.
        await context.executeReloadScopes(["harness:codex"]);
        if (!build.lease.isCurrent() || context.isShuttingDown()) return;
        await build.run("codexBridge", bridge => controller.initialize(bridge), "Codex recovery readiness");
      },
    });
    return {
      registrations: { codexLifecycle: controller },
      start: () => undefined,
      beginHandoff: () => ({
        waitForIdle: async () => { controller.pause(); },
        expire: () => controller.pause(),
        detach: () => undefined,
        resume: () => controller.resume(),
        commit: () => controller.dispose(),
      }),
      dispose: () => controller.dispose(),
    };
  },
  description: "Reload Codex supervision and restart its child app-server.",
  lifecycle: "handoff",
  provides: ["codexLifecycle"],
  requires: [],
  safeAll: false,
  destructive: true,
  scope: "server:codex/lifecycle",
  sources: [
    "daemon/server/CodexLifecycleNode.ts",
    "daemon/server/CodexLifecycleController.ts",
    "daemon/server/CodexRecoverySupervisor.ts",
  ].join("\n"),
});
