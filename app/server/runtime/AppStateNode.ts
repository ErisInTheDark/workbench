/*
 * Default export:
 * - AppStateNode: own typed app-state reads and mutations over the active database node.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import WorkbenchBrowserStateRegistry from "../state/WorkbenchBrowserStateRegistry.ts";
import { formatWorkbenchAppLogMessage } from "../workbench-app-log-format.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppCompilerNode from "./AppCompilerNode.ts";
import AppNetworkNode from "./AppNetworkNode.ts";
import AppHttpNode from "./AppHttpNode.ts";

export default new ReloadableNode<AppProcessContext, AppRuntimeObjects, never>({
  access: "operator",
  children: [AppCompilerNode, AppNetworkNode, AppHttpNode],
  create: (context, build) => {
    const logger = context.processLogger.withMessageFormatter(formatWorkbenchAppLogMessage);
    const state = new WorkbenchBrowserStateRegistry(build.get("database"), {
      onDiagnostic: (message) => logger.error("app", message),
    });
    return {
      dispose: async () => await state.close(),
      registrations: { logger, state },
      start: () => state.start(),
    };
  },
  description: "Reload typed app-state reads, projections, and mutations without replacing SQLite.",
  lifecycle: "atomic",
  provides: ["logger", "state"],
  requires: ["database"],
  safeAll: false,
  scope: "client:state",
  sources: [
    "app/server/runtime/AppStateNode.ts",
    "app/server/workbench-app-log-format.ts",
    "app/server/state/WorkbenchAppStateController.ts",
    "app/server/state/WorkbenchBrowserStateRegistry.ts",
    "shared/state/**",
    "!shared/state/workbench-app-state-schema.ts",
    "!shared/state/workbench-app-state-releases.ts",
    "shared/database/**",
  ].join("\n"),
});
