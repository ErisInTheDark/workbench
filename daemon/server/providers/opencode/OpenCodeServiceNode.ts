/*
 * Exports:
 * - default OpenCodeServiceNode: hand off the reloadable client and process for the user's shared OpenCode service,
 *   restarting a running service only after the reload commits or rolls back.
 */
import path from "node:path";
import ReloadableNode from "../../ReloadableNode";
import OpenCodeBridgeNode from "./OpenCodeBridgeNode";
import OpenCodeServiceController from "./OpenCodeServiceController";
import OpenCodeProvider from "./OpenCodeProvider";
import { resolveProviderRuntime } from "../provider-runtimes";
import { logError } from "../../process-helpers";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";

interface OpenCodeServiceHandoff {
  restart: boolean;
}

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "cli",
  children: [OpenCodeBridgeNode, OpenCodeProvider],
  create: (context, build) => {
    const inherited = build.handoffState as OpenCodeServiceHandoff | undefined;
    const service = new OpenCodeServiceController({
      resolveRuntime: dataRoot => resolveProviderRuntime(dataRoot, "opencode", context.providerRuntimePins.opencode()),
    });
    let restart = false;
    // The companion plugin calls back into Workbench while it loads, so a restart awaited inside a reload would wait on
    // that reload's own gates. Restarts run once gates reopen; failures leave the next on-demand acquire to retry.
    const restartInBackground = () => {
      void service.acquire().catch((error: unknown) => {
        logError("opencode", `OpenCode service restart failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
      });
    };
    const detach = async () => {
      try {
        restart = await service.suspend() || restart;
      } catch (error) {
        restart = true;
        throw error;
      }
      return { restart } satisfies OpenCodeServiceHandoff;
    };
    return {
      registrations: { openCodeService: service },
      start: () => undefined,
      afterCommit: () => {
        if (inherited?.restart) restartInBackground();
      },
      beginHandoff: () => ({
        waitForIdle: async () => undefined,
        expire: () => undefined,
        detach,
        retryDetach: detach,
        resume: () => {
          if (restart) restartInBackground();
        },
        commit: () => service.dispose(),
      }),
      dispose: () => service.dispose(),
    };
  },
  description: "Reconnect Workbench to the user's shared OpenCode service.",
  // OpenCode loads the Workbench plugin in its own process.
  entries: [path.join(__dirname, "workbench-plugin", "index.ts")],
  lifecycle: "handoff",
  provides: ["openCodeService"],
  requires: [],
  safeAll: false,
  destructive: true,
  scope: "harness:opencode",
});
