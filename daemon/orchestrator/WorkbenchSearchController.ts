/*
 * Exports:
 * - default WorkbenchSearchController: serializes just-in-time project/file projections before SQLite search. Keywords: search, project, projection, lifecycle.
 */
import ProjectTreeFileIndex from "workbench-shared/workbench/project/ProjectTreeFileIndex";
import type {
  WorkbenchSearchRequest,
  WorkbenchSearchResponse,
} from "workbench-shared/workbench/search/workbench-search";

interface SearchDatabase {
  replaceSearchProjectFiles(projectId: string, paths: readonly string[]): Promise<void>;
  replaceSearchProjects(projects: readonly { id: string; name: string; rootPath: string }[]): Promise<void>;
  search(request: WorkbenchSearchRequest): Promise<WorkbenchSearchResponse>;
}

export default class WorkbenchSearchController {
  private disposed = false;
  private readonly fileSignatures = new Map<string, string>();
  private projectionTail = Promise.resolve();

  constructor(private readonly options: {
    database: SearchDatabase;
    logWarning?(message: string): void;
    readCatalog(): Promise<{ data: readonly { id: string; name: string; rootPath: string }[] }>;
    readProjectSnapshot(projectId: string): Promise<{ tree: Parameters<typeof ProjectTreeFileIndex.fromTree>[0] }>;
  }) {}

  async search(request: WorkbenchSearchRequest) {
    this.assertActive();
    await this.enqueueProjection(request.projectId);
    this.assertActive();
    return await this.options.database.search(request);
  }

  async dispose() {
    this.disposed = true;
    await this.projectionTail;
  }

  private enqueueProjection(projectId: string | null) {
    const projection = this.projectionTail.then(async () => {
      this.assertActive();
      const catalog = await this.options.readCatalog();
      await this.options.database.replaceSearchProjects(catalog.data.map(({ id, name, rootPath }) => ({ id, name, rootPath })));
      if (!projectId) return;
      const snapshot = await this.options.readProjectSnapshot(projectId);
      const fileIndex = ProjectTreeFileIndex.fromTree(snapshot.tree);
      if (this.fileSignatures.get(projectId) === fileIndex.key) return;
      await this.options.database.replaceSearchProjectFiles(projectId, fileIndex.paths);
      this.fileSignatures.set(projectId, fileIndex.key);
    });
    this.projectionTail = projection.catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      (this.options.logWarning ?? console.warn)(`Workspace search projection failed: ${detail.slice(0, 500)}`);
    });
    return projection;
  }

  private assertActive() {
    if (this.disposed) throw new Error("Workbench search controller is disposed.");
  }
}
