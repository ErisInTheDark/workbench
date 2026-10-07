/*
 * Exports:
 * - default CodexExecServerNode: own the sandbox executor process, its Windows ACL repair and the machine-wide expensive-command slots; reloadable shell orchestration lives in a child.
 */
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexExecServer from "./CodexExecServer";
import CodexSandboxAclController from "./CodexSandboxAclController";
import CodexToolsNode from "./CodexToolsNode";
import OpenCodeProvider from "./providers/opencode/OpenCodeProvider";
import ClaudeProviderNode from "./providers/claude/ClaudeProviderNode";
import WorkbenchShellRunnerNode from "./WorkbenchShellRunnerNode";
import { logError } from "./process-helpers";
import os from "node:os";
import WorkbenchCommandCapacity, { expensiveCommandSlots } from "./WorkbenchCommandCapacity";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [WorkbenchShellRunnerNode, CodexToolsNode, OpenCodeProvider, ClaudeProviderNode],
  create: (context) => {
    const executor = new CodexExecServer({ cwd: context.daemonPackageRoot });
    const sandboxAcl = new CodexSandboxAclController();
    // Shared by every provider's shell so one machine-wide limit covers all agents' builds and test suites.
    const commandCapacity = new WorkbenchCommandCapacity({
      slots: expensiveCommandSlots({ cores: os.availableParallelism(), totalMemory: os.totalmem() }),
      readMemory: () => ({ free: os.freemem(), total: os.totalmem() }),
      log: message => { process.stdout.write(`${message}\n`); },
    });
    const retire = async () => {
      commandCapacity.dispose();
      await Promise.all([executor.dispose(), sandboxAcl.dispose()]);
    };
    return {
      registrations: { codexExecutor: executor, codexSandboxAcl: sandboxAcl, commandCapacity },
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
  description: "Restart the sandbox executor, interrupting running agent shell commands.",
  destructive: true,
  lifecycle: "handoff",
  provides: ["codexExecutor", "codexSandboxAcl", "commandCapacity"],
  requires: [],
  safeAll: false,
  scope: "server:commands/exec",
});
