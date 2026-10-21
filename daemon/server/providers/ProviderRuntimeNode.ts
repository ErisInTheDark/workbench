/*
 * Exports:
 * - default ProviderRuntimeNode: reload Workbench-installed provider runtime installs and their browser requests.
 */
import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../daemon-runtime-objects";
import ReloadableNode from "../runtime/ReloadableNode";
import ProviderRuntimeController from "./ProviderRuntimeController";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [],
  create: (context, { get }) => {
    const controller = new ProviderRuntimeController({
      dataRoot: context.dataRootPath,
      pins: context.providerRuntimePins,
      warn: message => console.warn(`[provider-runtimes] ${message.slice(0, 2000)}`),
    });
    const unregister = get("daemonRequests").registerProviderRuntimes(controller);
    return {
      registrations: {},
      start: async () => { controller.start(); },
      dispose: async () => { unregister(); await controller.dispose(); },
    };
  },
  description: "Reload Workbench-installed Claude Code and OpenCode runtime installs.",
  lifecycle: "atomic",
  provides: [],
  requires: ["daemonRequests"],
  safeAll: true,
  scope: "server:provider-runtimes",
});
