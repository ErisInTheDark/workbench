/*
 * Default export:
 * - AppDatabaseNode: own the reloadable SQLite connection and durable local registration.
 */
import path from "node:path";
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import WorkbenchPresentationRepository from "../state/WorkbenchPresentationRepository.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppStateNode from "./AppStateNode.ts";
import AppNetworkNode from "./AppNetworkNode.ts";

interface AppDatabaseReloadState {
  checkpointPath: string | null;
  presentationCheckpointPath: string | null;
  releaseCandidate?(): Promise<void>;
}

export default ReloadableNode.define<AppProcessContext, AppRuntimeObjects, never>()({
  access: "operator",
  children: [AppStateNode, AppNetworkNode],
  create: (context, build) => {
    const database = context.createDatabase(WorkbenchAppStateRepository);
    database.configureDiagnostics((level, message) => {
      if (level === "warn") context.processLogger.error("app", message.trimStart());
      else context.processLogger.line("app", message.trimStart());
    });
    const presentationDatabase = new WorkbenchPresentationRepository({
      databasePath: path.join(path.dirname(database.databasePath), "presentation-state.sqlite3"),
      onDiagnostic: message => context.processLogger.error("app", message),
    });
    const handoffState = build.handoffState as AppDatabaseReloadState | undefined;
    let detached = false;
    const close = async () => {
      const results = await Promise.allSettled([presentationDatabase.close(), database.close()]);
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "App databases could not both close.");
      detached = true;
    };
    if (handoffState) handoffState.releaseCandidate = close;
    return {
      beginHandoff: () => {
        const state: AppDatabaseReloadState = { checkpointPath: null, presentationCheckpointPath: null };
        return {
          waitForIdle: () => Promise.resolve(),
          expire: () => undefined,
          detach: async () => { await close(); return state; },
          resume: async () => {
            await state.releaseCandidate?.();
            await database.resume(state.checkpointPath ?? undefined);
            await presentationDatabase.resume(state.presentationCheckpointPath ?? undefined);
            detached = false;
          },
          commit: () => undefined,
        };
      },
      detachForReload: async () => {
        await close();
        return undefined;
      },
      dispose: async () => { if (!detached) await close(); },
      registrations: { database, presentationDatabase },
      start: async () => {
        await database.start(handoffState ? (backupPath) => { handoffState.checkpointPath = backupPath; } : undefined);
        await presentationDatabase.start(handoffState
          ? (backupPath) => { handoffState.presentationCheckpointPath = backupPath; } : undefined);
      },
    };
  },
  description: "Reload the app SQLite repository and schema boundary while preserving the durable database file.",
  lifecycle: "handoff",
  provides: ["database", "presentationDatabase"],
  requires: [],
  safeAll: false,
  scope: "client:database",
  sources: [
    "app/server/runtime/AppDatabaseNode.ts",
    "app/server/state/WorkbenchAppStateRepository.ts",
    "app/server/state/WorkbenchPresentationRepository.ts",
    "shared/state/workbench-presentation-schema.ts",
    "shared/state/workbench-presentation-releases.ts",
    "shared/state/workbench-app-state-schema.ts",
    "shared/state/workbench-app-state-releases.ts",
    "shared/state/workbench-network-state-schema.ts",
    "shared/database/**",
    "shared/workbench-data-root.ts",
    "shared/workbench/project/project-aliases.ts",
  ].join("\n"),
});
