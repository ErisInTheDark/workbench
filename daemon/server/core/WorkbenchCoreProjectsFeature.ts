/*
 * Exports:
 * - default WorkbenchCoreProjectsFeature: build the core generation's settings, project catalogue, snapshots, search, project store and project files.
 */
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonDatabaseRegistration } from "../daemon-runtime-objects";
import type { WorkbenchProjectStartup } from "../database/project/workbench-project-persistence";
import WorkbenchServerSettings from "../lib/workbench/settings/WorkbenchServerSettings";
import { readDeviceIdentity } from "../store/device-identity";
import WorkbenchProjectStore from "../store/WorkbenchProjectStore";
import WorkbenchProjectCatalogController from "../project/WorkbenchProjectCatalogController";
import WorkbenchProjectFileController from "../project/WorkbenchProjectFileController";
import WorkbenchProjectSnapshotController from "../project/WorkbenchProjectSnapshotController";
import WorkbenchSearchController from "../project/WorkbenchSearchController";

export default class WorkbenchCoreProjectsFeature {
  readonly settings: WorkbenchServerSettings;
  readonly catalog: WorkbenchProjectCatalogController;
  readonly snapshot: WorkbenchProjectSnapshotController;
  readonly search: WorkbenchSearchController;
  readonly store: WorkbenchProjectStore;
  readonly files: WorkbenchProjectFileController;

  constructor({ context, database, initialCatalog }: {
    context: DaemonProcessContext;
    database: DaemonDatabaseRegistration;
    initialCatalog?: WorkbenchProjectStartup;
  }) {
    this.settings = new WorkbenchServerSettings(database);
    const catalog = this.catalog = new WorkbenchProjectCatalogController({
      initialProjects: initialCatalog,
      // The daemon's own checkout always has a project, so wb feedback and Workbench threads have an owner.
      pinnedProjectRoots: [context.legacyMigrationProjectRoot],
      persistence: database,
      settings: this.settings,
    });
    const snapshot = this.snapshot = new WorkbenchProjectSnapshotController({
      observeProject: (projectId) => { void catalog.observeProjectIcon(ProjectIdSchema.parse(projectId)); },
      resolveProjectById: (projectId) => catalog.resolveProjectById(projectId),
    });
    this.search = new WorkbenchSearchController({
      database,
      readCatalog: () => catalog.readCatalog(),
      readProjectSnapshot: (projectId) => snapshot.readProjectSnapshot(projectId),
    });
    this.store = new WorkbenchProjectStore({
      execute: command => database.executeProjectStore(command),
      readDeviceIdentity,
      resolveProjectById: projectId => catalog.resolveProjectById(projectId),
      resolveProjectFromCwd: cwd => catalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Project store" }),
    });
    this.files = new WorkbenchProjectFileController(catalog, snapshot);
  }
}
