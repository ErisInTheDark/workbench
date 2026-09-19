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
import CodexCommandExecController from "./CodexCommandExecController";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [CodexProvider],
  create: (_context, { get }) => {
    const threads = get("codexThreadOperations");
    const commandExec = new CodexCommandExecController({
      requestCodex: async request => ({
        id: request.id ?? null,
        result: await threads.requestNative(request.method!, (request.params ?? {}) as object),
      }),
    });
    const tools = new CodexToolsController({
      commandExec,
      resolvePatchCaller: (threadId, cwd) => threads.resolvePatchCaller(threadId, cwd),
      readCallerThread: async nativeThreadId => {
        const thread = await threads.read(nativeThreadId);
        return { id: WorkbenchThreadIdSchema.parse(thread.id), cwd: thread.cwd };
      },
      shell: new CodexShellController({
        executor: get("codexExecutor"),
        readConfiguration: cwd => threads.requestNative("config/read", { cwd, includeLayers: false }),
      }),
    });
    return { registrations: { codexTools: tools }, start: () => undefined, dispose: () => undefined };
  },
  description: "Reload Codex tool identity and sandbox execution.",
  lifecycle: "atomic",
  provides: ["codexTools"],
  requires: ["codexThreadOperations", "codexExecutor"],
  safeAll: true,
  scope: "server:codex/tools",
  sources: [
    "daemon/server/CodexToolsNode.ts",
    "daemon/server/CodexToolsController.ts",
    "daemon/server/CodexShellController.ts",
    "daemon/server/CodexCommandExecController.ts",
  ].join("\n"),
});
