/*
 * Default export:
 * - AppDatabaseNode: own the reloadable SQLite connection and durable local registration.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppStateNode from "./AppStateNode.ts";

interface AppDatabaseReloadState {
  checkpointPath: string | null;
  releaseCandidate?(): Promise<void>;
}

export default new ReloadableNode<AppProcessContext, AppRuntimeObjects, never>({
  access: "operator",
  children: [AppStateNode],
  create: (context, build) => {
    const database = context.createDatabase(WorkbenchAppStateRepository);
    const handoffState = build.handoffState as AppDatabaseReloadState | undefined;
    if (handoffState) handoffState.releaseCandidate = () => database.close();
    let detached = false;
    const close = async () => {
      await database.close();
      detached = true;
    };
    return {
      beginHandoff: () => {
        const state: AppDatabaseReloadState = { checkpointPath: null };
        return {
          waitForIdle: () => Promise.resolve(),
          expire: () => undefined,
          detach: async () => { await close(); return state; },
          resume: async () => {
            await state.releaseCandidate?.();
            await database.resume(state.checkpointPath ?? undefined);
            detached = false;
          },
          commit: () => undefined,
        };
      },
      detachForReload: async () => {
        await close();
        return undefined;
      },
      dispose: async () => { if (!detached) await database.close(); },
      registrations: { database },
      start: async () => {
        await database.start(handoffState ? (backupPath) => { handoffState.checkpointPath = backupPath; } : undefined);
      },
    };
  },
  description: "Reload the app SQLite repository and schema boundary while preserving the durable database file.",
  lifecycle: "handoff",
  provides: ["database"],
  requires: [],
  safeAll: false,
  scope: "client:database",
  sources: [
    "app/server/runtime/AppDatabaseNode.ts",
    "app/server/state/WorkbenchAppStateRepository.ts",
    "shared/state/workbench-app-state-schema.ts",
    "shared/state/workbench-app-state-releases.ts",
    "shared/database/**",
    "shared/workbench/project/project-aliases.ts",
  ].join("\n"),
});
