/*
 * Exports:
 * - default WorkbenchShellRunnerNode: reload agent shell orchestration and its process-wide runner slot without restarting the sandbox executor.
 */
import ReloadableNode from "./ReloadableNode";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import WorkbenchShellRunner from "./WorkbenchShellRunner";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [],
  create: (_context, build) => {
    const shellRunner = new WorkbenchShellRunner({ executor: build.get("codexExecutor"), capacity: build.get("commandCapacity") });
    const requestRegistry = getProcessWorkbenchAgentMcpRequestRegistry();
    const runnerOwner = {};
    return {
      registrations: { shellRunner },
      // Agent shells run here, leasing only this node, so reloads above it never wait on a running command.
      afterCommit: () => {
        requestRegistry.activateShellRunner(runnerOwner, async (run, signal) => (
          await build.run("shellRunner", runner => runner.run(run, signal), "shell run")
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
