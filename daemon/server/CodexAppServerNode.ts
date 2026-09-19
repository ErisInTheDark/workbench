/*
 * Exports:
 * - default CodexAppServerNode: own the stable Codex app-server process and declare its bridge child.
 */
import CodexBridgeNode from "./CodexBridgeNode";
import CodexAppServerRuntime from "./CodexAppServerRuntime";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import type CodexAppServer from "./CodexAppServer";
import { log, logError } from "./process-helpers";

interface CodexServerHandoff {
  appServer: CodexAppServer;
}

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "cli",
  children: [CodexBridgeNode],
  create: (context, build) => {
    const previous = build.handoffState as CodexServerHandoff | undefined;
    const lifecycle = build.get("codexLifecycle");
    const runtime = new CodexAppServerRuntime({
      appServer: { log, logError, projectRoot: context.daemonPackageRoot },
      onFatalExit: reason => lifecycle.requestRecovery(reason),
    }, { previousAppServer: previous?.appServer });
    const reportRetirement = (error: unknown) => {
      logError("codex-server", `previous process retirement failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
    };
    return {
      afterCommit: () => {
        void runtime.retirePrevious().catch(reportRetirement);
      },
      beginHandoff: () => ({
        waitForIdle: async () => {},
        expire: () => {},
        detach: () => ({ appServer: runtime.appServer } satisfies CodexServerHandoff),
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
  requires: ["codexLifecycle"],
  safeAll: false,
  destructive: true,
  scope: "harness:codex",
  sources: [
    "daemon/server/CodexAppServerNode.ts",
    "daemon/server/CodexAppServerRuntime.ts",
    "daemon/server/CodexAppServer.ts",
  ].join("\n"),
});
