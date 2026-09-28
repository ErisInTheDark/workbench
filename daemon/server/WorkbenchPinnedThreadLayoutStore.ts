/*
 * Exports:
 * - default WorkbenchPinnedThreadLayoutStore: conform and consolidate retained pin layouts for app presentation import.
 */

import { z } from "zod";
import { ThreadDisplayKeySchema, type ProjectId } from "workbench-shared/workbench/identity";

import {
  getProjectQualifiedThreadDisplayKey,
  normalizeThreadDisplayLayout,
  ThreadDisplayLayoutSchema,
  type ThreadDisplayLayout,
} from "workbench-shared/workbench/thread/thread-display-layout";
import {
  getWorkbenchThreadDisplayKey,
  getWorkbenchThreadDisplaySection,
  type WorkbenchThreadDisplayOrder,
} from "workbench-shared/workbench/thread/thread-display-order";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import type {
  WorkbenchPinnedThreadLayoutSnapshot,
  WorkbenchThreadSidebarEntry,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadStatePersistence } from "./WorkbenchThreadStateStore";

const StoredPinnedThreadLayoutSchema = z.object({
  displayOrder: ThreadDisplayLayoutSchema,
  importedProjectIds: z.array(z.string().min(1).brand<"ProjectId">()),
  revision: z.number().int().nonnegative(),
  version: z.literal(1),
}).strict();
type StoredPinnedThreadLayout = z.infer<typeof StoredPinnedThreadLayoutSchema>;
interface WorkbenchPinnedThreadLayoutStoreOptions {
  reportRepairs?: (repairedPaths: PropertyKey[][]) => void;
}

const EMPTY_STORED_LAYOUT: StoredPinnedThreadLayout = {
  displayOrder: {},
  importedProjectIds: [],
  revision: 0,
  version: 1,
};

function qualifyProjectPinnedOrder(projectId: ProjectId, entries: readonly WorkbenchThreadSidebarEntry[], candidate: unknown) {
  const localKeys = new Set<string>(entries.filter((entry) => getWorkbenchThreadDisplaySection(entry) === "pinned").map(getWorkbenchThreadDisplayKey));
  const qualify = (key: string) => key.startsWith("folder:")
    ? key
    : getProjectQualifiedThreadDisplayKey(projectId, ThreadDisplayKeySchema.parse(key));
  const order = normalizeThreadDisplayLayout(candidate);
  const folders = (order.folders ?? []).flatMap((folder) => {
    if (folder.section !== "pinned") return [];
    const threadKeys = folder.threadKeys.filter((key) => localKeys.has(key)).map(qualify);
    return threadKeys.length ? [{ ...folder, threadKeys }] : [];
  });
  const pinned = Object.fromEntries(Object.entries(order.pinned ?? {}).flatMap(([key, position]) => {
    if (!key.startsWith("folder:") && !localKeys.has(key)) return [];
    return [[qualify(key), {
      above: position.above.filter((candidateKey) => candidateKey.startsWith("folder:") || localKeys.has(candidateKey)).map(qualify),
      below: position.below.filter((candidateKey) => candidateKey.startsWith("folder:") || localKeys.has(candidateKey)).map(qualify),
    }]];
  }));
  return {
    ...(folders.length ? { folders } : {}),
    ...(Object.keys(pinned).length ? { pinned } : {}),
  } satisfies ThreadDisplayLayout;
}

export default class WorkbenchPinnedThreadLayoutStore {
  private loadPromise: Promise<StoredPinnedThreadLayout> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly reportRepairs: (repairedPaths: PropertyKey[][]) => void;
  private state: StoredPinnedThreadLayout | null = null;

  constructor(
    private readonly persistence: WorkbenchThreadStatePersistence,
    options: WorkbenchPinnedThreadLayoutStoreOptions = {},
  ) {
    this.reportRepairs = options.reportRepairs ?? (() => undefined);
  }

  async getSnapshot(): Promise<WorkbenchPinnedThreadLayoutSnapshot> {
    const state = await this.load();
    return { displayOrder: state.displayOrder, revision: state.revision, updateKind: "pinnedThreadLayout" };
  }

  async importProject(projectId: ProjectId, entries: readonly WorkbenchThreadSidebarEntry[], displayOrder: WorkbenchThreadDisplayOrder) {
    return await this.enqueue(async () => {
      const state = await this.load();
      if (state.importedProjectIds.includes(projectId)) return null;
      const imported = qualifyProjectPinnedOrder(projectId, entries, displayOrder);
      const existingFolderIds = new Set(state.displayOrder.folders?.map(({ folderId }) => folderId) ?? []);
      if ((imported.folders ?? []).some(({ folderId }) => existingFolderIds.has(folderId))) {
        throw new Error("A pinned thread folder id collides with an existing global folder.");
      }
      const nextOrder = normalizeThreadDisplayLayout({
        ...state.displayOrder,
        folders: [...state.displayOrder.folders ?? [], ...imported.folders ?? []],
        pinned: { ...state.displayOrder.pinned, ...imported.pinned },
      });
      return await this.commit({
        displayOrder: nextOrder,
        importedProjectIds: [...state.importedProjectIds, projectId],
        revision: state.revision + 1,
        version: 1,
      });
    });
  }

  private async load() {
    if (this.state) return this.state;
    this.loadPromise ??= this.persistence.readGlobal("pinnedLayout").then(async (stored) => {
      const candidate = stored ?? EMPTY_STORED_LAYOUT;
      const conformed = conformToZodSchema(StoredPinnedThreadLayoutSchema, candidate, EMPTY_STORED_LAYOUT);
      this.reportRepairs(conformed.repairedPaths);
      if (stored === null || conformed.repairedPaths.length) {
        await this.persistence.writeGlobal("pinnedLayout", conformed.data);
      }
      this.state = conformed.data;
      return this.state;
    });
    return await this.loadPromise;
  }

  private async commit(next: StoredPinnedThreadLayout) {
    await this.persistence.writeGlobal("pinnedLayout", next);
    this.state = next;
    return { displayOrder: next.displayOrder, revision: next.revision, updateKind: "pinnedThreadLayout" as const };
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
