/*
 * Exports:
 * - default WorkbenchShellRunnerNode: reload agent shell orchestration and its process-wide runner slot without restarting the sandbox executor.
 */
import path from "node:path";

import NativeArtifactStage from "workbench-shared/process/NativeArtifactStage";
import ReloadableNode from "../runtime/ReloadableNode";
import { logError } from "../process-helpers";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "../agent/workbench-agent-mcp-request-registry";
import WorkbenchShellRunner from "./WorkbenchShellRunner";
import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../daemon-runtime-objects";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [],
  create: (context, build) => {
    // Each command runs a staged copy, so republishing the committed binary never meets a locked file.
    const stage = new NativeArtifactStage({ runtimeRoot: context.dataRootPath, warn: message => logError("shell-runner", message) });
    const windowsJobRunner = async () => await stage.stage({
      label: "host",
      executable: path.join(context.daemonPackageRoot, "host", "bin", `windows-${process.arch}`, "workbench-daemon-host.exe"),
    });
    const shellRunner = new WorkbenchShellRunner({
      executor: build.get("codexExecutor"), capacity: build.get("commandCapacity"),
      ...(process.platform === "win32" ? { windowsJobRunner } : {}),
    });
    const requestRegistry = getProcessWorkbenchAgentMcpRequestRegistry();
    const runnerOwner = {};
    return {
      registrations: { shellRunner },
      // Agent shells run here, leasing only this node, so reloads above it never wait on a running command.
      afterCommit: () => {
        requestRegistry.activateShellRunner(runnerOwner, async (run, signal, ticket) => (
          await build.run("shellRunner", runner => runner.run(run, signal, ticket), "shell run")
        ));
      },
      start: () => undefined,
      // Running commands finish on the kernel executor that admitted them; retiring only stops new admission.
      dispose: () => { requestRegistry.releaseShellRunner(runnerOwner); },
    };
  },
  description: "Reload agent shell orchestration without restarting the sandbox executor.",
  destructive: false,
  lifecycle: "atomic",
  provides: ["shellRunner"],
  requires: ["codexExecutor", "commandCapacity"],
  safeAll: true,
  scope: "server:commands/shell",
});
