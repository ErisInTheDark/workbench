/*
 * Exports:
 * - default WorkbenchPinnedThreadLayoutStore: own Workbench-wide pinned folders, atomic row drops, sparse ordering, compatibility import, and authoritative SQLite persistence. Keywords: pinned, global, layout, folder, storage, sqlite.
 */

import { z } from "zod";

import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  createThreadDisplayFolder,
  getProjectQualifiedThreadDisplayKey,
  moveThreadDisplayLayoutItem,
  normalizeThreadDisplayLayout,
  removeThreadDisplayLayoutMember,
  renameThreadDisplayFolder,
  replaceThreadDisplayFolderMember,
  ThreadDisplayLayoutSchema,
  type ThreadDisplayLayout,
  type ThreadDisplayLayoutEntry,
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
  WorkbenchThreadStateRequest,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadStatePersistence } from "./WorkbenchThreadStateStore";

const StoredPinnedThreadLayoutSchema = z.object({
  displayOrder: ThreadDisplayLayoutSchema,
  importedProjectIds: z.array(z.string().min(1)),
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

type PinnedLayoutMutation = Extract<WorkbenchThreadStateRequest, {
  method:
    | "workbench/thread-state/pinned-display-order/folder/create"
    | "workbench/thread-state/pinned-display-order/folder/title/set"
    | "workbench/thread-state/pinned-display-order/move";
}>;
type PinnedFolderDrop = Extract<WorkbenchThreadStateRequest, {
  method: "workbench/thread-state/pinned-display-order/folder/drop";
}>;

function projectLayoutEntries(projectId: string, entries: readonly WorkbenchThreadSidebarEntry[]) {
  return entries.flatMap((entry): ThreadDisplayLayoutEntry[] => (
    getWorkbenchThreadDisplaySection(entry) === "pinned"
      ? [{ key: getProjectQualifiedThreadDisplayKey(projectId, getWorkbenchThreadDisplayKey(entry)), section: "pinned" }]
      : []
  ));
}

function qualifyProjectPinnedOrder(projectId: string, entries: readonly WorkbenchThreadSidebarEntry[], candidate: unknown) {
  const localKeys = new Set(entries.filter((entry) => getWorkbenchThreadDisplaySection(entry) === "pinned").map(getWorkbenchThreadDisplayKey));
  const qualify = (key: string) => key.startsWith("folder:")
    ? key
    : getProjectQualifiedThreadDisplayKey(projectId, key);
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

  async importProject(projectId: string, entries: readonly WorkbenchThreadSidebarEntry[], displayOrder: WorkbenchThreadDisplayOrder) {
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

  async mutate(entries: readonly ThreadDisplayLayoutEntry[], request: PinnedLayoutMutation) {
    return await this.enqueue(async () => {
      const state = await this.load();
      const next = request.method === "workbench/thread-state/pinned-display-order/folder/create"
        ? createThreadDisplayFolder(entries, state.displayOrder, request.folderId, request.sourceKey, request.title, { preserveMissing: true })
        : request.method === "workbench/thread-state/pinned-display-order/folder/title/set"
          ? renameThreadDisplayFolder(state.displayOrder, request.folderId, request.title)
          : moveThreadDisplayLayoutItem(entries, state.displayOrder, "pinned", request.sourceKey, request.destinationFolderId, request.beforeKey, { preserveMissing: true });
      if (!next) return { accepted: false, snapshot: null };
      if (areDeeplyEqual(next, state.displayOrder)) return { accepted: true, snapshot: null };
      const snapshot = await this.commit({ ...state, displayOrder: next, revision: state.revision + 1 });
      return { accepted: true, snapshot };
    });
  }

  async remove(projectId: string, threadKey: string) {
    return await this.enqueue(async () => {
      const state = await this.load();
      const next = removeThreadDisplayLayoutMember(state.displayOrder, getProjectQualifiedThreadDisplayKey(projectId, threadKey));
      if (areDeeplyEqual(next, state.displayOrder)) return null;
      return await this.commit({ ...state, displayOrder: next, revision: state.revision + 1 });
    });
  }

  async replace(projectId: string, sourceThreadKey: string, replacementThreadKey: string) {
    return await this.enqueue(async () => {
      const state = await this.load();
      const next = replaceThreadDisplayFolderMember(
        state.displayOrder,
        getProjectQualifiedThreadDisplayKey(projectId, sourceThreadKey),
        getProjectQualifiedThreadDisplayKey(projectId, replacementThreadKey),
      );
      if (areDeeplyEqual(next, state.displayOrder)) return null;
      return await this.commit({ ...state, displayOrder: next, revision: state.revision + 1 });
    });
  }

  async waitForIdle() {
    await this.operationQueue;
  }

  async dropThread(entries: readonly ThreadDisplayLayoutEntry[], request: PinnedFolderDrop) {
    return await this.enqueue(async () => {
      const state = await this.load();
      if (request.sourceKey === request.targetKey) return { accepted: false, snapshot: null };
      let next: ThreadDisplayLayout | null = state.displayOrder;
      if (request.destinationFolderId) {
        const folder = state.displayOrder.folders?.find(({ folderId }) => folderId === request.destinationFolderId);
        if (!folder || folder.section !== "pinned" || !folder.threadKeys.includes(request.targetKey)) {
          return { accepted: false, snapshot: null };
        }
        next = moveThreadDisplayLayoutItem(entries, state.displayOrder, "pinned", request.sourceKey, folder.folderId, folder.threadKeys[0] ?? null, { preserveMissing: true });
      } else if (request.folderId) {
        next = createThreadDisplayFolder(entries, state.displayOrder, request.folderId, request.targetKey, "New folder", { preserveMissing: true });
        if (next) {
          next = moveThreadDisplayLayoutItem(entries, next, "pinned", request.sourceKey, request.folderId, request.targetKey, { preserveMissing: true });
        }
      }
      if (!next) return { accepted: false, snapshot: null };
      if (areDeeplyEqual(next, state.displayOrder)) return { accepted: true, snapshot: null };
      const snapshot = await this.commit({ ...state, displayOrder: next, revision: state.revision + 1 });
      return { accepted: true, snapshot };
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
