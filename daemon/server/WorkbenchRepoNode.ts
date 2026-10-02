/*
 * Exports:
 * - default WorkbenchRepoNode: own virtual repository mounts above the command, MCP and WebSocket surfaces that expose them.
 */
import path from "node:path";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchRepoController from "./WorkbenchRepoController";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import WorkbenchRepoProcess from "./lib/workbench/repo/WorkbenchRepoProcess";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [WorkbenchAgentCommandNode, WorkbenchMcpNode, WorkbenchWebSocketNode],
  create: (context, build) => {
    const toolRevision = build.get("toolRevision");
    const root = path.resolve(context.daemonPackageRoot, "..");
    const cacheDirectory = path.join(context.dataRootPath, ".cache", "repos");
    const warn = (message: string) => console.warn(`[repo] ${message}`);
    const repo = new WorkbenchRepoController({
      cacheDirectory,
      probe: async () => await WorkbenchRepoProcess.probe(root, warn),
      startSidecar: async () => await WorkbenchRepoProcess.start(root, cacheDirectory, warn),
      bumpToolRevision: () => toolRevision.bump(),
      warn,
    });
    return {
      // Mount paths are exclusive: the old sidecar must unmount before a replacement mounts.
      beginHandoff: () => ({
        waitForIdle: () => repo.waitForIdle(),
        expire: () => repo.expireInflight(),
        detach: async () => { await repo.suspend(); },
        resume: () => repo.resume(),
        commit: () => undefined,
      }),
      dispose: () => repo.dispose(),
      registrations: { repo },
      // Reconcile in the background so a slow probe or remount never blocks daemon startup.
      start: () => { void repo.start(); },
    };
  },
  description: "Reload virtual repository mounts; live mounts are unmounted and remounted.",
  lifecycle: "handoff",
  provides: ["repo"],
  requires: ["toolRevision"],
  safeAll: false,
  scope: "server:repo",
});
