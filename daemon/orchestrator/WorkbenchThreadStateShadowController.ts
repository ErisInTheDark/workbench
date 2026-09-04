/*
 * Exports:
 * - WorkbenchThreadStateShadowDatabase: typed database-worker port for non-serving relational projection. Keywords: thread state, shadow, database.
 * - default WorkbenchThreadStateShadowController: own projection dirt, queueing, failure reporting, and disposal. Keywords: thread state, shadow, lifecycle.
 */
import type { WorkbenchSubagentRelationship } from "workbench-shared/types";

import type {
  WorkbenchThreadStateShadowRefresh,
  WorkbenchThreadStateShadowStatus,
} from "./database/thread-state/workbench-thread-state-shadow-types";

export interface WorkbenchThreadStateShadowDatabase {
  rebuildThreadStateShadow(request: WorkbenchThreadStateShadowRefresh): Promise<WorkbenchThreadStateShadowStatus>;
  recordThreadStateShadowFailure(request: WorkbenchThreadStateShadowRefresh): Promise<WorkbenchThreadStateShadowStatus>;
}

export default class WorkbenchThreadStateShadowController {
  private readonly database: WorkbenchThreadStateShadowDatabase;
  private readonly dirtyGlobals = new Set<"homeDisplayOrder" | "pinnedLayout">();
  private readonly dirtyProjects = new Set<string>();
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly relationships = new Map<string, WorkbenchSubagentRelationship>();
  private accepting = true;
  private activeDrain: Promise<void> | null = null;
  private fullRefresh = false;
  private relationshipsDirty = false;
  private started = false;

  constructor(options: {
    database: WorkbenchThreadStateShadowDatabase;
    log?: (message: string) => void;
    now?: () => number;
  }) {
    this.database = options.database;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  markGlobal(id: "homeDisplayOrder" | "pinnedLayout") {
    if (!this.accepting) return;
    this.dirtyGlobals.add(id);
    this.schedule();
  }

  markProject(projectId: string) {
    if (!this.accepting) return;
    this.dirtyProjects.add(projectId);
    this.schedule();
  }

  replaceRelationships(relationships: readonly WorkbenchSubagentRelationship[]) {
    this.relationships.clear();
    for (const relationship of relationships) {
      this.relationships.set(
        `${relationship.projectId}\0${relationship.harness}\0${relationship.threadId}`,
        relationship,
      );
    }
    if (!this.accepting) return;
    this.relationshipsDirty = true;
    this.schedule();
  }

  start() {
    if (!this.accepting) return Promise.resolve();
    if (!this.started) {
      this.started = true;
      this.fullRefresh = true;
      this.schedule();
    }
    return this.waitForIdle();
  }

  async waitForIdle() {
    while (this.activeDrain) await this.activeDrain;
  }

  async dispose() {
    this.accepting = false;
    this.dirtyGlobals.clear();
    this.dirtyProjects.clear();
    this.fullRefresh = false;
    this.relationshipsDirty = false;
    await this.waitForIdle();
  }

  private hasDirt() {
    return this.fullRefresh
      || this.relationshipsDirty
      || this.dirtyGlobals.size > 0
      || this.dirtyProjects.size > 0;
  }

  private schedule() {
    if (!this.started || !this.accepting || this.activeDrain || !this.hasDirt()) return;
    const drain = this.drain().finally(() => {
      if (this.activeDrain === drain) this.activeDrain = null;
      if (this.hasDirt()) this.schedule();
    });
    this.activeDrain = drain;
  }

  private async drain() {
    while (this.accepting && this.hasDirt()) {
      this.fullRefresh = false;
      this.relationshipsDirty = false;
      this.dirtyGlobals.clear();
      this.dirtyProjects.clear();
      const request: WorkbenchThreadStateShadowRefresh = {
        now: this.now(),
        relationships: [...this.relationships.values()].sort((left, right) => (
          `${left.projectId}\0${left.harness}\0${left.threadId}`
            .localeCompare(`${right.projectId}\0${right.harness}\0${right.threadId}`)
        )),
      };
      try {
        await this.database.rebuildThreadStateShadow(request);
      } catch {
        this.log("Thread-state shadow projection failed; serving authority remains unchanged.");
        try {
          await this.database.recordThreadStateShadowFailure(request);
        } catch {
          this.log("Thread-state shadow failure status could not be recorded.");
        }
      }
    }
  }
}
