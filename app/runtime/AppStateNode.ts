/*
 * Default export:
 * - AppStateNode: own typed app-state reads and mutations over the active database node. Keywords: app, state, reload.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import WorkbenchAppStateController from "../state/WorkbenchAppStateController.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppHttpNode from "./AppHttpNode.ts";

export default new ReloadableNode<AppProcessContext, AppRuntimeObjects, never>({
  access: "operator",
  children: [AppHttpNode],
  create: (_context, build) => {
    const state = new WorkbenchAppStateController(build.get("database"));
    return {
      dispose: () => {},
      registrations: { state },
      start: () => {},
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
    "shared/state/**",
    "shared/database/**",
  ].join("\n"),
});
