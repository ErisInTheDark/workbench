/*
 * Exports:
 * - default CodexToolsNode: provide native tool adaptation from the current bridge to the Codex definition.
 */
import ReloadableNode from "../../runtime/ReloadableNode";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import CodexProvider from "./CodexProvider";
import CodexToolsController from "./CodexToolsController";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchAgentCommandNode from "../../agent/WorkbenchAgentCommandNode";
import WorkbenchExecReaperNode from "../../exec/WorkbenchExecReaperNode";
import { createWorkbenchShellController, WORKBENCH_SANDBOX_SHELL_REQUIRES } from "../../exec/WorkbenchSandboxShell";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [CodexProvider, WorkbenchAgentCommandNode, WorkbenchExecReaperNode],
  create: (context, { get }) => {
    const threads = get("codexThreadOperations");
    const tools = new CodexToolsController({
      executor: get("codexExecutor"),
      resolvePatchCaller: (threadId, cwd) => threads.resolvePatchCaller(threadId, cwd),
      readCallerThread: async nativeThreadId => {
        const thread = await threads.read(nativeThreadId);
        return { id: WorkbenchThreadIdSchema.parse(thread.id), cwd: thread.cwd };
      },
      sandboxAcl: get("codexSandboxAcl"),
      shell: createWorkbenchShellController(context, { get }),
    });
    return { registrations: { codexTools: tools }, start: () => undefined, dispose: () => undefined };
  },
  description: "Reload Codex tool identity and sandbox execution.",
  lifecycle: "atomic",
  provides: ["codexTools"],
  requires: ["codexThreadOperations", ...WORKBENCH_SANDBOX_SHELL_REQUIRES],
  safeAll: true,
  scope: "server:codex/tools",
});
