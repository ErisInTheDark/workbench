/*
 * Default export:
 * - AppDatabaseNode: own the reloadable SQLite connection and durable local registration. Keywords: app, database, handoff.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppStateNode from "./AppStateNode.ts";

export default new ReloadableNode<AppProcessContext, AppRuntimeObjects, never>({
  access: "operator",
  children: [AppStateNode],
  create: (context) => {
    const database = context.createDatabase(WorkbenchAppStateRepository);
    let detached = false;
    const close = () => {
      database.close();
      detached = true;
    };
    return {
      detachForReload: () => {
        close();
        return undefined;
      },
      dispose: () => { if (!detached) database.close(); },
      registrations: { database },
      start: () => { database.start(); },
    };
  },
  description: "Reload the app SQLite repository and schema boundary while preserving the durable database file.",
  lifecycle: "handoff",
  provides: ["database"],
  requires: [],
  safeAll: false,
  scope: "client:database",
  sources: [
    "app/runtime/AppDatabaseNode.ts",
    "app/state/WorkbenchAppStateRepository.ts",
    "app/workbench-library-root.ts",
    "shared/state/workbench-app-state-schema.ts",
    "shared/database/**",
  ].join("\n"),
});
