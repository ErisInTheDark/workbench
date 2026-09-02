/*
 * Default export:
 * - AppStateNode: own typed app-state reads and mutations over the active database node. Keywords: app, state, reload.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import WorkbenchBrowserStateRegistry from "../state/WorkbenchBrowserStateRegistry.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppCompilerNode from "./AppCompilerNode.ts";
import AppHttpNode from "./AppHttpNode.ts";

export default new ReloadableNode<AppProcessContext, AppRuntimeObjects, never>({
  access: "operator",
  children: [AppCompilerNode, AppHttpNode],
  create: (context, build) => {
    const state = new WorkbenchBrowserStateRegistry(build.get("database"), {
      onDiagnostic: (message) => context.logger.error("app", message),
    });
    return {
      dispose: async () => await state.close(),
      registrations: { state },
      start: () => state.start(),
    };
  },
  description: "Reload typed app-state reads, projections, and mutations without replacing SQLite.",
  lifecycle: "atomic",
  provides: ["state"],
  requires: ["database"],
  safeAll: false,
  scope: "client:state",
  sources: [
    "app/runtime/AppStateNode.ts",
    "app/state/WorkbenchAppStateController.ts",
    "app/state/WorkbenchBrowserStateRegistry.ts",
    "shared/state/**",
    "!shared/state/workbench-app-state-schema.ts",
    "shared/database/**",
  ].join("\n"),
});
