/*
 * Exports:
 * - default OpenCodeServiceNode: hand off the reloadable client and process for the user's shared OpenCode service.
 */
import path from "node:path";
import ReloadableNode from "../../ReloadableNode";
import OpenCodeBridgeNode from "./OpenCodeBridgeNode";
import OpenCodeServiceController from "./OpenCodeServiceController";
import OpenCodeProvider from "./OpenCodeProvider";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";

interface OpenCodeServiceHandoff {
  restart: boolean;
}

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "cli",
  children: [OpenCodeBridgeNode, OpenCodeProvider],
  create: (_context, build) => {
    const inherited = build.handoffState as OpenCodeServiceHandoff | undefined;
    const service = new OpenCodeServiceController();
    let restart = false;
    return {
      registrations: { openCodeService: service },
      start: async () => {
        if (inherited?.restart) await service.acquire();
      },
      beginHandoff: () => ({
        waitForIdle: async () => undefined,
        expire: () => undefined,
        detach: async () => {
          restart = await service.suspend();
          return { restart } satisfies OpenCodeServiceHandoff;
        },
        resume: async () => {
          if (restart) await service.acquire();
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
