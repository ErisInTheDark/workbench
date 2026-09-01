/*
 * Exports:
 * - default WorkbenchHomeThreadDisplayOrderStore: own revisioned home priority order and durable atomic persistence. Keywords: home, thread, order, storage.
 */

import path from "node:path";
import { z } from "zod";

import { areDeeplyEqual } from "../lib/workbench/deep-equality";
import {
  moveWorkbenchHomeThreadDisplayItem,
  normalizeWorkbenchHomeThreadDisplayOrder,
  removeWorkbenchHomeThreadDisplayMember,
  replaceWorkbenchHomeThreadDisplayMember,
  WorkbenchHomeThreadDisplayOrderSchema,
} from "../lib/workbench/thread/home-thread-display-order";
import { getProjectQualifiedThreadDisplayKey, type ThreadDisplayLayoutEntry } from "../lib/workbench/thread/thread-display-layout";
import type { WorkbenchThreadDisplaySection } from "../lib/workbench/thread/thread-display-order";
import { conformToZodSchema } from "../lib/workbench/zod-schema-conformer";
import type { WorkbenchHomeThreadDisplayOrderSnapshot } from "../lib/workbench/thread/thread-state";
import AtomicJsonStore from "./AtomicJsonStore";

const StoredHomeThreadDisplayOrderSchema = z.object({
  displayOrder: WorkbenchHomeThreadDisplayOrderSchema,
  revision: z.number().int().nonnegative(),
  version: z.literal(1),
}).strict();
type StoredHomeThreadDisplayOrder = z.infer<typeof StoredHomeThreadDisplayOrderSchema>;

const EMPTY_STORED_ORDER: StoredHomeThreadDisplayOrder = {
  displayOrder: {},
  revision: 0,
  version: 1,
};

export default class WorkbenchHomeThreadDisplayOrderStore {
  private readonly filePath: string;
  private loadPromise: Promise<StoredHomeThreadDisplayOrder> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private state: StoredHomeThreadDisplayOrder | null = null;

  constructor(
    storageRoot: string,
    private readonly reportRepairs: (repairedPaths: PropertyKey[][]) => void = () => undefined,
    private readonly json = new AtomicJsonStore(),
  ) {
    this.filePath = path.join(storageRoot, ".workbench", "runtime", "home-thread-display-order.json");
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
    await this.json.waitForIdle();
  }

  private async load() {
    if (this.state) return this.state;
    this.loadPromise ??= this.json.read<unknown>(this.filePath, EMPTY_STORED_ORDER).then((candidate) => {
      const conformed = conformToZodSchema(StoredHomeThreadDisplayOrderSchema, candidate, EMPTY_STORED_ORDER);
      this.reportRepairs(conformed.repairedPaths);
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
    await this.json.write(this.filePath, next);
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
