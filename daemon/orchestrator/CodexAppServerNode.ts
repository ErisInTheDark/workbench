/*
 * Exports:
 * - default CodexAppServerNode: own the stable Codex app-server process and declare its bridge child. Keywords: codex, app-server, parent.
 */
import CodexBridgeNode from "./CodexBridgeNode";
import CodexAppServerRuntime from "./CodexAppServerRuntime";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import type CodexAppServer from "./CodexAppServer";
import { logError } from "./process-helpers";

interface CodexServerHandoff {
  appServer: CodexAppServer;
  retire(): Promise<void>;
}

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "cli",
  children: [CodexBridgeNode],
  create: (context, build) => {
    const previous = build.handoffState as CodexServerHandoff | undefined;
    const runtime = new CodexAppServerRuntime(context, { previousAppServer: previous?.appServer });
    const reportRetirement = (error: unknown) => {
      logError("codex-server", `previous process retirement failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
    };
    return {
      afterCommit: () => {
        void previous?.retire().catch(reportRetirement);
      },
      beginHandoff: () => ({
        waitForIdle: async () => {},
        expire: () => {},
        detach: () => ({ appServer: runtime.appServer, retire: () => runtime.stop() } satisfies CodexServerHandoff),
        resume: () => {},
        commit: () => runtime.stop(),
      }),
      dispose: () => runtime.stop(),
      shutdown: () => runtime.stop(),
      registrations: { codexAppServer: runtime },
      start: () => undefined,
    };
  },
  description: "Restart the Codex app-server process and rebuild its bridge.",
  lifecycle: "handoff",
  provides: ["codexAppServer"],
  requires: [],
  safeAll: false,
  scope: "harness:codex",
  sources: [
    "daemon/orchestrator/CodexAppServerNode.ts",
    "daemon/orchestrator/CodexAppServerRuntime.ts",
    "daemon/orchestrator/CodexAppServer.ts",
  ].join("\n"),
});
