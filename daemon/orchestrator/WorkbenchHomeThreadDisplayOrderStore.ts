/*
 * Exports:
 * - default WorkbenchHomeThreadDisplayOrderStore: own revisioned home priority order and authoritative SQLite persistence. Keywords: home, thread, order, storage, sqlite.
 */

import { z } from "zod";

import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  moveWorkbenchHomeThreadDisplayItem,
  normalizeWorkbenchHomeThreadDisplayOrder,
  removeWorkbenchHomeThreadDisplayMember,
  replaceWorkbenchHomeThreadDisplayMember,
  WorkbenchHomeThreadDisplayOrderSchema,
} from "workbench-shared/workbench/thread/home-thread-display-order";
import { getProjectQualifiedThreadDisplayKey, type ThreadDisplayLayoutEntry } from "workbench-shared/workbench/thread/thread-display-layout";
import type { WorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import type { WorkbenchHomeThreadDisplayOrderSnapshot } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadStatePersistence } from "./WorkbenchThreadStateStore";

const StoredHomeThreadDisplayOrderSchema = z.object({
  displayOrder: WorkbenchHomeThreadDisplayOrderSchema,
  revision: z.number().int().nonnegative(),
  version: z.literal(1),
}).strict();
type StoredHomeThreadDisplayOrder = z.infer<typeof StoredHomeThreadDisplayOrderSchema>;
interface WorkbenchHomeThreadDisplayOrderStoreOptions {
  reportRepairs?: (repairedPaths: PropertyKey[][]) => void;
}

const EMPTY_STORED_ORDER: StoredHomeThreadDisplayOrder = {
  displayOrder: {},
  revision: 0,
  version: 1,
};

export default class WorkbenchHomeThreadDisplayOrderStore {
  private loadPromise: Promise<StoredHomeThreadDisplayOrder> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly reportRepairs: (repairedPaths: PropertyKey[][]) => void;
  private state: StoredHomeThreadDisplayOrder | null = null;

  constructor(
    private readonly persistence: WorkbenchThreadStatePersistence,
    options: WorkbenchHomeThreadDisplayOrderStoreOptions = {},
  ) {
    this.reportRepairs = options.reportRepairs ?? (() => undefined);
  }

  async getSnapshot(): Promise<WorkbenchHomeThreadDisplayOrderSnapshot> {
    return this.snapshot(await this.load());
  }

  async move(
    entries: readonly ThreadDisplayLayoutEntry[],
    section: WorkbenchThreadDisplaySection,
    sourceKeys: readonly string[],
    beforeKey: string | null,
  ) {
    return await this.enqueue(async () => {
      const state = await this.load();
      const next = moveWorkbenchHomeThreadDisplayItem(entries, state.displayOrder, section, sourceKeys, beforeKey);
      if (!next) return { accepted: false, snapshot: null };
      return { accepted: true, snapshot: await this.commitIfChanged(state, next) };
    });
  }

  async remove(projectId: string, threadKey: string) {
    return await this.enqueue(async () => {
      const state = await this.load();
      const next = removeWorkbenchHomeThreadDisplayMember(
        state.displayOrder,
        getProjectQualifiedThreadDisplayKey(projectId, threadKey),
      );
      return await this.commitIfChanged(state, next);
    });
  }

  async replace(
    sourceProjectId: string,
    sourceThreadKey: string,
    replacementThreadKey: string,
    replacementProjectId = sourceProjectId,
  ) {
    return await this.enqueue(async () => {
      const state = await this.load();
      const next = replaceWorkbenchHomeThreadDisplayMember(
        state.displayOrder,
        getProjectQualifiedThreadDisplayKey(sourceProjectId, sourceThreadKey),
        getProjectQualifiedThreadDisplayKey(replacementProjectId, replacementThreadKey),
      );
      return await this.commitIfChanged(state, next);
    });
  }

  async waitForIdle() {
    await this.operationQueue;
  }

  private async load() {
    if (this.state) return this.state;
    this.loadPromise ??= this.persistence.readGlobal("homeDisplayOrder").then(async (stored) => {
      const candidate = stored ?? EMPTY_STORED_ORDER;
      const conformed = conformToZodSchema(StoredHomeThreadDisplayOrderSchema, candidate, EMPTY_STORED_ORDER);
      this.reportRepairs(conformed.repairedPaths);
      if (stored === null || conformed.repairedPaths.length) {
        await this.persistence.writeGlobal("homeDisplayOrder", conformed.data);
      }
      this.state = conformed.data;
      return this.state;
    });
    return await this.loadPromise;
  }

  private async commitIfChanged(
    state: StoredHomeThreadDisplayOrder,
    displayOrder: StoredHomeThreadDisplayOrder["displayOrder"],
  ) {
    if (areDeeplyEqual(displayOrder, state.displayOrder)) return null;
    return await this.commit({ ...state, displayOrder, revision: state.revision + 1 });
  }

  private async commit(next: StoredHomeThreadDisplayOrder) {
    await this.persistence.writeGlobal("homeDisplayOrder", next);
    this.state = next;
    return this.snapshot(next);
  }

  private snapshot(state: StoredHomeThreadDisplayOrder): WorkbenchHomeThreadDisplayOrderSnapshot {
    return {
      displayOrder: normalizeWorkbenchHomeThreadDisplayOrder(state.displayOrder),
      revision: state.revision,
      updateKind: "homeThreadDisplayOrder",
    };
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
