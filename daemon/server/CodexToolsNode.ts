/*
 * Exports:
 * - default CodexToolsNode: provide native tool adaptation from the current bridge to the Codex definition.
 */
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexProvider from "./CodexProvider";
import CodexToolsController from "./CodexToolsController";
import CodexShellController from "./CodexShellController";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchExecReaperNode from "./WorkbenchExecReaperNode";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [CodexProvider, WorkbenchAgentCommandNode, WorkbenchExecReaperNode],
  create: (_context, { get }) => {
    const threads = get("codexThreadOperations");
    const sandboxAcl = get("codexSandboxAcl");
    const executor = get("codexExecutor");
    const tools = new CodexToolsController({
      executor,
      resolvePatchCaller: (threadId, cwd) => threads.resolvePatchCaller(threadId, cwd),
      readCallerThread: async nativeThreadId => {
        const thread = await threads.read(nativeThreadId);
        return { id: WorkbenchThreadIdSchema.parse(thread.id), cwd: thread.cwd };
      },
      sandboxAcl,
      shell: new CodexShellController({
        executor,
        sandboxAcl,
        readConfiguration: cwd => threads.requestNative("config/read", { cwd, includeLayers: false }),
      }),
    });
    return { registrations: { codexTools: tools }, start: () => undefined, dispose: () => undefined };
  },
  description: "Reload Codex tool identity and sandbox execution.",
  lifecycle: "atomic",
  provides: ["codexTools"],
  requires: ["codexThreadOperations", "codexExecutor", "codexSandboxAcl"],
  safeAll: true,
  scope: "server:codex/tools",
});
