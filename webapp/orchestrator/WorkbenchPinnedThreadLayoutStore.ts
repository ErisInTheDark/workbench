/*
 * Exports:
 * - default WorkbenchPinnedThreadLayoutStore: own Workbench-wide pinned folders, sparse ordering, compatibility import, authoritative JSON persistence, and SQLite shadow parity. Keywords: pinned, global, layout, folder, storage, sqlite.
 */

import path from "node:path";
import { z } from "zod";

import { areDeeplyEqual } from "../lib/workbench/deep-equality";
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
} from "../lib/workbench/thread/thread-display-layout";
import {
  getWorkbenchThreadDisplayKey,
  getWorkbenchThreadDisplaySection,
  type WorkbenchThreadDisplayOrder,
} from "../lib/workbench/thread/thread-display-order";
import { conformToZodSchema } from "../lib/workbench/zod-schema-conformer";
import type {
  WorkbenchPinnedThreadLayoutSnapshot,
  WorkbenchThreadSidebarEntry,
  WorkbenchThreadStateRequest,
} from "../lib/workbench/thread/thread-state";
import AtomicJsonStore from "./AtomicJsonStore";
import WorkbenchThreadStateStore from "./WorkbenchThreadStateStore";

const StoredPinnedThreadLayoutSchema = z.object({
  displayOrder: ThreadDisplayLayoutSchema,
  importedProjectIds: z.array(z.string().min(1)),
  revision: z.number().int().nonnegative(),
  version: z.literal(1),
}).strict();
type StoredPinnedThreadLayout = z.infer<typeof StoredPinnedThreadLayoutSchema>;
interface WorkbenchPinnedThreadLayoutStoreOptions {
  json?: AtomicJsonStore;
  reportRepairs?: (repairedPaths: PropertyKey[][]) => void;
  reportSqliteIssue?: (message: string) => void;
  sqlite?: WorkbenchThreadStateStore;
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
  private readonly filePath: string;
  private readonly json: AtomicJsonStore;
  private loadPromise: Promise<StoredPinnedThreadLayout> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly reportRepairs: (repairedPaths: PropertyKey[][]) => void;
  private readonly reportSqliteIssue: (message: string) => void;
  private readonly sqlite: WorkbenchThreadStateStore | null;
  private state: StoredPinnedThreadLayout | null = null;

  constructor(storageRoot: string, options: WorkbenchPinnedThreadLayoutStoreOptions = {}) {
    this.filePath = path.join(storageRoot, ".workbench", "runtime", "pinned-thread-layout.json");
    this.json = options.json ?? new AtomicJsonStore();
    this.reportRepairs = options.reportRepairs ?? (() => undefined);
    this.reportSqliteIssue = options.reportSqliteIssue ?? (() => undefined);
    this.sqlite = options.sqlite ?? null;
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
    await this.json.waitForIdle();
  }

  private async load() {
    if (this.state) return this.state;
    this.loadPromise ??= this.json.read<unknown>(this.filePath, EMPTY_STORED_LAYOUT).then((candidate) => {
      const conformed = conformToZodSchema(StoredPinnedThreadLayoutSchema, candidate, EMPTY_STORED_LAYOUT);
      this.reportRepairs(conformed.repairedPaths);
      this.state = conformed.data;
      return this.state;
    }).then((state) => {
      this.baselineSqlite(state);
      return state;
    });
    return await this.loadPromise;
  }

  private async commit(next: StoredPinnedThreadLayout) {
    await this.json.write(this.filePath, next);
    this.verifySqlite(next);
    this.state = next;
    return { displayOrder: next.displayOrder, revision: next.revision, updateKind: "pinnedThreadLayout" as const };
  }

  private conformSqlite(candidate: unknown) {
    return conformToZodSchema(StoredPinnedThreadLayoutSchema, candidate, EMPTY_STORED_LAYOUT).data;
  }

  private baselineSqlite(state: StoredPinnedThreadLayout) {
    if (!this.sqlite) return;
    this.sqlite.baselineGlobal(
      "pinnedLayout",
      state,
      (candidate) => this.conformSqlite(candidate),
      this.reportSqliteIssue,
    );
  }

  private verifySqlite(state: StoredPinnedThreadLayout) {
    if (!this.sqlite) return;
    this.sqlite.writeAndVerifyGlobal(
      "pinnedLayout",
      state,
      (candidate) => this.conformSqlite(candidate),
      this.reportSqliteIssue,
    );
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
