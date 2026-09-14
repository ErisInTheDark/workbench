/*
 * Exports:
 * - default OpenCodeAppServerNode: own the OpenCode app-server process and declare its bridge child.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import OpenCodeAppServer from "./OpenCodeAppServer";
import OpenCodeBridgeNode from "./OpenCodeBridgeNode";
import ReloadableNode from "./ReloadableNode";
import { logError } from "./process-helpers";

interface OpenCodeServerHandoff {
  appServer: OpenCodeAppServer;
}

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "cli",
  children: [OpenCodeBridgeNode],
  create: (context, build) => {
    const previous = build.handoffState as OpenCodeServerHandoff | undefined;
    const appServer = new OpenCodeAppServer({
      ...context.openCodeAppServerOptions, previousAppServer: previous?.appServer,
    });
    let detached = false;
    return {
      afterCommit: () => {
        // The process owner also gates replacement startup on this retirement.
        void appServer.retirePrevious().catch((error) => {
          logError("opencode-server", `previous server retirement failed: ${String(error instanceof Error ? error.message : error).slice(0, 1_000)}`);
        });
      },
      beginHandoff: () => ({
        waitForIdle: async () => {},
        expire: () => {},
        detach: () => ({ appServer } satisfies OpenCodeServerHandoff),
        resume: () => {},
        commit: () => appServer.stop(),
      }),
      detachForReload: async () => {
        await appServer.stop();
        detached = true;
      },
      dispose: async () => { if (!detached) await appServer.stop(); },
      shutdown: () => appServer.stop(),
      registrations: { openCodeAppServer: appServer },
      start: () => undefined,
    };
  },
  description: "Restart the OpenCode app-server process and rebuild its bridge.",
  lifecycle: "handoff",
  provides: ["openCodeAppServer"],
  requires: [],
  safeAll: false,
  scope: "harness:opencode",
  sources: [
    "daemon/server/OpenCodeAppServerNode.ts",
    "daemon/server/OpenCodeAppServer.ts",
    "daemon/server/OpenCodeServerProcess.ts",
  ].join("\n"),
});
