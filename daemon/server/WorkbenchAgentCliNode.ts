/*
 * Exports:
 * - default WorkbenchAgentCliNode: install daemon-discovering wb agent shims in an isolated reloadable boundary.
 */
import path from "node:path";

import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchAgentCliEnvironment from "./WorkbenchAgentCliEnvironment";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [],
  create: (context) => {
    const cliRoot = path.join(context.daemonPackageRoot, "server", "lib", "workbench", "cli");
    const environment = new WorkbenchAgentCliEnvironment({
      resolverSourcePath: path.join(cliRoot, "resolve-workbench-daemon-origin.mts"),
      runtimeDirectoryPath: path.join(context.daemonPackageRoot, "node_modules", ".bin"),
      shellSourcePath: path.join(cliRoot, "workbench-agent-cli.sh"),
    });
    return {
      dispose: () => undefined,
      registrations: {},
      start: async () => { await environment.install(); },
    };
  },
  description: "Reload daemon-discovering wb command shims without replacing command or provider state.",
  lifecycle: "atomic",
  provides: [],
  requires: [],
  safeAll: true,
  scope: "server:cli",
  sources: [
    "wb",
    "daemon/server/WorkbenchAgentCliEnvironment.ts",
    "daemon/server/WorkbenchAgentCliNode.ts",
    "daemon/server/lib/workbench/cli/workbench-agent-cli.sh",
    "daemon/server/lib/workbench/cli/resolve-workbench-daemon-origin.mts",
  ].join("\n"),
});
