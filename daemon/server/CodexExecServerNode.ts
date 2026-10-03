/*
 * Exports:
 * - default CodexExecServerNode: retain the sandbox executor and its Windows ACL repair independently of tool-definition reloads.
 */
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexExecServer from "./CodexExecServer";
import CodexSandboxAclController from "./CodexSandboxAclController";
import CodexToolsNode from "./CodexToolsNode";
import OpenCodeProvider from "./providers/opencode/OpenCodeProvider";
import ClaudeProviderNode from "./providers/claude/ClaudeProviderNode";
import { logError } from "./process-helpers";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [CodexToolsNode, OpenCodeProvider, ClaudeProviderNode],
  create: context => {
    const executor = new CodexExecServer({ cwd: context.daemonPackageRoot });
    const sandboxAcl = new CodexSandboxAclController();
    const retire = async () => { await Promise.all([executor.dispose(), sandboxAcl.dispose()]); };
    return {
      registrations: { codexExecutor: executor, codexSandboxAcl: sandboxAcl },
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
  provides: ["codexExecutor", "codexSandboxAcl"],
  requires: [],
  safeAll: true,
  scope: "server:commands/exec",
});
