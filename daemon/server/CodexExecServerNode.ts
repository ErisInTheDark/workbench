/*
 * Exports:
 * - default CodexExecServerNode: retain the sandbox executor, its Windows ACL repair, the machine-wide expensive-command slots and the agent shell runner independently of tool-definition reloads.
 */
import ReloadableNode from "./ReloadableNode";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import WorkbenchShellRunner from "./WorkbenchShellRunner";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexExecServer from "./CodexExecServer";
import CodexSandboxAclController from "./CodexSandboxAclController";
import CodexToolsNode from "./CodexToolsNode";
import OpenCodeProvider from "./providers/opencode/OpenCodeProvider";
import ClaudeProviderNode from "./providers/claude/ClaudeProviderNode";
import { logError } from "./process-helpers";
import os from "node:os";
import WorkbenchCommandCapacity, { expensiveCommandSlots } from "./WorkbenchCommandCapacity";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [CodexToolsNode, OpenCodeProvider, ClaudeProviderNode],
  create: (context, build) => {
    const executor = new CodexExecServer({ cwd: context.daemonPackageRoot });
    const sandboxAcl = new CodexSandboxAclController();
    // Shared by every provider's shell so one machine-wide limit covers all agents' builds and test suites.
    const commandCapacity = new WorkbenchCommandCapacity({
      slots: expensiveCommandSlots({ cores: os.availableParallelism(), totalMemory: os.totalmem() }),
      readMemory: () => ({ free: os.freemem(), total: os.totalmem() }),
      log: message => { process.stdout.write(`${message}\n`); },
    });
    const shellRunner = new WorkbenchShellRunner({ executor, capacity: commandCapacity });
    // Agent shells run here, leasing only this node, so reloads above it never wait on a running command.
    const requestRegistry = getProcessWorkbenchAgentMcpRequestRegistry();
    const runnerOwner = {};
    const retire = async () => {
      requestRegistry.releaseShellRunner(runnerOwner);
      commandCapacity.dispose();
      await Promise.all([executor.dispose(), sandboxAcl.dispose()]);
    };
    return {
      registrations: { codexExecutor: executor, codexSandboxAcl: sandboxAcl, commandCapacity, shellRunner },
      afterCommit: () => {
        requestRegistry.activateShellRunner(runnerOwner, async (run, signal) => (
          await build.run("shellRunner", runner => runner.run(run, signal), "shell run")
        ));
      },
      start: () => undefined,
      beginHandoff: () => ({
        // A half-propagated tree is safe but leaves agents read-only until the successor rescans it.
        waitForIdle: () => sandboxAcl.idle(),
        expire: () => {
          void retire().catch(error => logError("codex-exec", `Executor retirement failed: ${String(error).slice(0, 400)}`));
        },
        detach: () => undefined,
        resume: () => undefined,
        commit: retire,
      }),
      dispose: retire,
      shutdown: retire,
    };
  },
  description: "Reload the sandbox executor after graph-owned operations drain.",
  destructive: false,
  lifecycle: "handoff",
  provides: ["codexExecutor", "codexSandboxAcl", "commandCapacity", "shellRunner"],
  requires: [],
  safeAll: true,
  scope: "server:commands/exec",
});
