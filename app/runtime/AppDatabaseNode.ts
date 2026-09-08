/*
 * Keywords: app, SQLite, migration backup, reload, lifecycle.
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
    const close = async () => {
      await database.close();
      detached = true;
    };
    return {
      detachForReload: async () => {
        await close();
        return undefined;
      },
      dispose: async () => { if (!detached) await database.close(); },
      registrations: { database },
      start: async () => { await database.start(); },
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
    "shared/state/workbench-app-state-schema.ts",
    "shared/state/workbench-app-state-releases.ts",
    "shared/database/**",
  ].join("\n"),
});
