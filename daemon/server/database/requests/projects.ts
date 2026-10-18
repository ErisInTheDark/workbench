/*
 * Exports:
 * - projectRequests: database requests for the project catalogue, project identity and icons, thread launches, the project store and search.
 */
import type { WorkbenchSearchRequest } from "workbench-shared/workbench/search/workbench-search";
import type { WorkbenchThreadLaunchLocation, WorkbenchThreadLaunchRequest, WorkbenchThreadLaunchState } from "workbench-shared/workbench/thread/thread-launch";
import type { WorkbenchProjectDiscovery, WorkbenchProjectIconSettlement } from "../project/workbench-project-persistence.ts";
import WorkbenchProjectStoreRepository, { type ProjectStoreCommand } from "../store/WorkbenchProjectStoreRepository.ts";
import { defineDatabaseRequest } from "./define-database-request.ts";

function requireLaunch<Launch>(launch: Launch | null, action: string): Launch {
  if (!launch) throw new Error(`Unexpected launch ${action} response.`);
  return launch;
}

export const projectRequests = {
  readRetainedProjectCatalog: defineDatabaseRequest({
    read: "core",
    run: ({ projects }, discoveryRoots: readonly string[]) => projects.readRetained(discoveryRoots),
  }),
  reconcileProjectCatalog: defineDatabaseRequest({
    run: ({ projects }, discovery: WorkbenchProjectDiscovery) => projects.reconcile(discovery),
  }),
  readProjectAliases: defineDatabaseRequest({
    read: "core",
    run: ({ projects }) => projects.readAliases(),
  }),
  resolveProjectIdentity: defineDatabaseRequest({
    read: "core",
    run: ({ projects }, projectId: string) => projects.resolve(projectId),
  }),
  settleProjectIcon: defineDatabaseRequest({
    run: ({ projects }, settlement: WorkbenchProjectIconSettlement) => projects.settleIcon(settlement),
  }),
  reserveThreadLaunch: defineDatabaseRequest({
    run: ({ threadLaunches }, request: WorkbenchThreadLaunchRequest, location: WorkbenchThreadLaunchLocation) => (
      requireLaunch(threadLaunches.reserve(request, location), "admission")
    ),
  }),
  readThreadLaunch: defineDatabaseRequest({
    read: "core",
    run: ({ threadLaunches }, launchId: string) => {
      const retained = threadLaunches.read(launchId);
      return retained ? { request: retained.request, location: retained.location, state: retained.state } : null;
    },
  }),
  advanceThreadLaunch: defineDatabaseRequest({
    run: ({ threadLaunches }, launchId: string, from: WorkbenchThreadLaunchState["phase"], next: WorkbenchThreadLaunchState) => (
      requireLaunch(threadLaunches.advance(launchId, from, next), "settlement")
    ),
  }),
  executeProjectStore: defineDatabaseRequest({
    run: ({ database }, command: ProjectStoreCommand) => new WorkbenchProjectStoreRepository(database).execute(command),
  }),
  replaceSearchProjects: defineDatabaseRequest({
    run: ({ search }, projects: readonly { id: string; name: string; rootPath: string }[]) => { search.replaceProjects(projects); },
  }),
  replaceSearchProjectFiles: defineDatabaseRequest({
    run: ({ search }, projectId: string, paths: readonly string[]) => { search.replaceProjectFiles(projectId, paths); },
  }),
  // The search repository lives only on the writer.
  search: defineDatabaseRequest({
    run: ({ search }, request: WorkbenchSearchRequest) => search.search(request),
  }),
};
