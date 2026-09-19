/*
 * Exports:
 * - default CodexExecServerNode: retain the sandbox executor independently of tool-definition reloads.
 */
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexExecServer from "./CodexExecServer";
import CodexToolsNode from "./CodexToolsNode";
import { logError } from "./process-helpers";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [CodexToolsNode],
  create: context => {
    const executor = new CodexExecServer({ cwd: context.daemonPackageRoot });
    return {
      registrations: { codexExecutor: executor },
      start: () => undefined,
      beginHandoff: () => ({
        waitForIdle: async () => {},
        expire: () => {
          void executor.dispose().catch(error => logError("codex-exec", `Executor retirement failed: ${String(error).slice(0, 400)}`));
        },
        detach: () => undefined,
        resume: () => undefined,
        commit: () => executor.dispose(),
      }),
      dispose: () => executor.dispose(),
      shutdown: () => executor.dispose(),
    };
  },
  description: "Reload the sandbox executor after graph-owned operations drain.",
  destructive: false,
  lifecycle: "handoff",
  provides: ["codexExecutor"],
  requires: [],
  safeAll: true,
  scope: "server:codex/exec",
  sources: [
    "daemon/server/CodexExecServerNode.ts",
    "daemon/server/CodexExecServer.ts",
    "daemon/server/codex-exec-protocol.ts",
  ].join("\n"),
});
