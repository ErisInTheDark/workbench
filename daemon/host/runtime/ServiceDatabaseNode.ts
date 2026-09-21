/*
 * Exports:
 * - default ServiceDatabaseNode: own typed service persistence and reload metadata above dependent owners.
 */
import path from "node:path";
import ReloadableNode from "../../../shared/reload/ReloadableNode.ts";
import ReloadDirtController, { type ReloadDirtControllerState } from "../../../shared/reload/ReloadDirtController.ts";
import WorkbenchServiceRepository from "../WorkbenchServiceRepository.ts";
import WorkbenchNetworkImport from "../WorkbenchNetworkImport.ts";
import WorkbenchServiceReloadController from "./WorkbenchServiceReloadController.ts";
import type { ServiceProcessContext } from "./service-process-context.ts";
import type { ServiceRuntimeObjects } from "./service-runtime-objects.ts";
import ServiceNetworkNode from "./ServiceNetworkNode.ts";

interface Handoff {
  backup?: string;
  dirt: ReloadDirtControllerState;
  reload: ReturnType<WorkbenchServiceReloadController["transfer"]>;
  releaseCandidate?(): Promise<void>;
}

export default ReloadableNode.define<ServiceProcessContext, ServiceRuntimeObjects, never>()({
  scope: "host:database", access: "operator", lifecycle: "handoff", safeAll: false,
  description: "Reload service persistence and its dependant network and HTTP owners.",
  requires: [], provides: ["database", "dirt", "reload"], children: [ServiceNetworkNode],
  sources: [
    "daemon/host/runtime/ServiceDatabaseNode.ts", "daemon/host/runtime/WorkbenchServiceReloadController.ts",
    "daemon/host/WorkbenchServiceRepository.ts", "daemon/host/WorkbenchNetworkImport.ts",
    "shared/state/workbench-service-*.ts", "shared/state/workbench-network-state-schema.ts", "shared/database/**",
    "shared/reload/ReloadDirtController.ts", "shared/reload/ReloadSourceWatcher.ts", "shared/reload/ReloadDirtSnapshotRepository.ts",
  ].join("\n"),
  create(context, build) {
    const state = build.handoffState as Handoff | undefined;
    const database = new WorkbenchServiceRepository({ databasePath: path.join(context.dataRoot, "service", "service.sqlite3") });
    const dirt = new ReloadDirtController({
      repoRoot: context.root, snapshotRef: "refs/worktree/workbench/host-reload-snapshot",
      getSourceState: build.getSourceState, onChange: context.publish,
    }, state?.dirt ?? null);
    const reload = new WorkbenchServiceReloadController({ dirt, execute: context.reload, restart: context.restart, warn: context.warn }, state?.reload);
    if (state) state.releaseCandidate = () => database.close();
    let detached = false;
    const detach = async (): Promise<Handoff> => {
      await database.close();
      detached = true;
      return { dirt: dirt.detachForReload(), reload: reload.transfer() };
    };
    return {
      registrations: { database, dirt, reload },
      start: async () => {
        await database.start(state ? backup => { state.backup = backup; } : undefined);
        await new WorkbenchNetworkImport(database).run(path.join(context.dataRoot, "app", "app-state.sqlite3"));
        await dirt.start();
      },
      beginHandoff: () => {
        let transferred: Handoff | undefined;
        return {
          waitForIdle: async () => {},
          expire: () => {},
          detach: async () => { transferred = await detach(); return transferred; },
          resume: async () => {
            await transferred?.releaseCandidate?.();
            await database.resume(transferred?.backup);
            dirt.resumeAfterFailedReload();
            detached = false;
          },
          commit: () => reload.close(),
        };
      },
      detachForReload: detach,
      dispose: async () => {
        reload.close();
        if (!detached) {
          const results = await Promise.allSettled([database.close(), dirt.dispose()]);
          const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
          if (failures.length) throw new AggregateError(failures, "Service persistence disposal failed.");
        }
      },
    };
  },
});
