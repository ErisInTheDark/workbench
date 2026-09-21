/*
 * Exports:
 * - default OpenCodeServiceNode: own the reloadable client for the user's shared OpenCode service.
 */
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
  lifecycle: "atomic",
  provides: ["openCodeService"],
  requires: [],
  safeAll: false,
  destructive: true,
  scope: "harness:opencode",
  sources: [
    "daemon/server/providers/opencode/OpenCodeServiceNode.ts",
    "daemon/server/providers/opencode/OpenCodeServiceController.ts",
    "daemon/server/providers/opencode/workbench-plugin/index.ts",
    "daemon/server/providers/opencode/workbench-plugin/OpenCodeCompanionToolsController.ts",
    "daemon/server/providers/opencode/workbench-plugin/OpenCodePatchStreamController.ts",
    "daemon/server/providers/opencode/workbench-plugin/open-code-tool-stream.ts",
    "daemon/server/providers/opencode/workbench-plugin/open-code-patch-preview.ts",
    "daemon/server/providers/opencode/opencode-workbench-rpc.ts",
  ].join("\n"),
});
