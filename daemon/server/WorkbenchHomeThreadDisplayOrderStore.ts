/*
 * Exports:
 * - default WorkbenchHomeThreadDisplayOrderStore: read and conform retained home order for app presentation import.
 */

import { z } from "zod";
import {
  normalizeWorkbenchHomeThreadDisplayOrder,
  WorkbenchHomeThreadDisplayOrderSchema,
} from "workbench-shared/workbench/thread/home-thread-display-order";
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

  private snapshot(state: StoredHomeThreadDisplayOrder): WorkbenchHomeThreadDisplayOrderSnapshot {
    return {
      displayOrder: normalizeWorkbenchHomeThreadDisplayOrder(state.displayOrder),
      revision: state.revision,
      updateKind: "homeThreadDisplayOrder",
    };
  }

}
