/*
 * Exports:
 * - default OpenCodeServiceNode: own the reloadable client for the user's shared OpenCode service.
 */
import path from "node:path";
import ReloadableNode from "../../ReloadableNode";
import OpenCodeBridgeNode from "./OpenCodeBridgeNode";
import OpenCodeServiceController from "./OpenCodeServiceController";
import OpenCodeProvider from "./OpenCodeProvider";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "cli",
  children: [OpenCodeBridgeNode, OpenCodeProvider],
  create: () => {
    const service = new OpenCodeServiceController();
    return {
      registrations: { openCodeService: service },
      start: () => undefined,
      dispose: () => service.dispose(),
    };
  },
  description: "Reconnect Workbench to the user's shared OpenCode service.",
  // OpenCode loads the Workbench plugin in its own process.
  entries: [path.join(__dirname, "workbench-plugin", "index.ts")],
  lifecycle: "atomic",
  provides: ["openCodeService"],
  requires: [],
  safeAll: false,
  destructive: true,
  scope: "harness:opencode",
});
