/*
 * Exports:
 * - default WorkbenchAgentCliNode: stage the agent wb launcher in an isolated reloadable boundary.
 */
import path from "node:path";

import NativeArtifactStage from "workbench-shared/process/NativeArtifactStage";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchAgentCliEnvironment from "./WorkbenchAgentCliEnvironment";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [],
  create: (context) => {
    const warn = (message: string) => console.warn(`[cli] ${message}`);
    const environment = new WorkbenchAgentCliEnvironment({
      checkoutRoot: path.resolve(context.daemonPackageRoot, ".."),
      legacyShimDirectoryPath: path.join(context.daemonPackageRoot, "node_modules", ".bin"),
      stage: new NativeArtifactStage({ runtimeRoot: context.dataRootPath, warn }),
      warn,
    });
    return {
      dispose: () => undefined,
      registrations: {},
      start: async () => {
        const startedAt = performance.now();
        if (process.env.WORKBENCH_STARTUP_DIAGNOSTICS === "1") console.info("[startup] daemon CLI setup");
        await environment.install();
        if (process.env.WORKBENCH_STARTUP_DIAGNOSTICS === "1") console.info(`[startup] daemon CLI ready in ${Math.round(performance.now() - startedAt)}ms`);
      },
    };
  },
  description: "Reload the staged agent wb launcher without replacing command or provider state.",
  lifecycle: "atomic",
  provides: [],
  requires: [],
  safeAll: true,
  scope: "server:cli",
  // Agents run the staged copy; rebuilding the committed launcher marks this scope dirty until reload re-stages it.
  assets: ["/wb", "/package/wb", "/daemon/launcher/bin/"].join("\n"),
});
