/*
 * Exports:
 * - WorkbenchThreadStateShadowDatabase: typed database-worker port for non-serving relational projection. Keywords: thread state, shadow, database.
 * - default WorkbenchThreadStateShadowController: own projection dirt, queueing, failure reporting, and disposal. Keywords: thread state, shadow, lifecycle.
 */
import type {
  WorkbenchSubagentParentSnapshot,
  WorkbenchThreadStateShadowRefresh,
  WorkbenchThreadStateShadowStatus,
} from "./database/thread-state/workbench-thread-state-shadow-types";

export interface WorkbenchThreadStateShadowDatabase {
  rebuildThreadStateShadow(request: WorkbenchThreadStateShadowRefresh): Promise<WorkbenchThreadStateShadowStatus>;
}

export default class WorkbenchThreadStateShadowController {
  private readonly database: WorkbenchThreadStateShadowDatabase;
  private readonly dirtyGlobals = new Set<"homeDisplayOrder" | "pinnedLayout">();
  private readonly dirtyProjects = new Set<string>();
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly subagentParents = new Map<string, WorkbenchSubagentParentSnapshot>();
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

  replaceSubagentParents(parents: readonly WorkbenchSubagentParentSnapshot[]) {
    this.subagentParents.clear();
    for (const parent of parents) {
      this.subagentParents.set(
        `${parent.projectId}\0${parent.harness}\0${parent.parentThreadId}`,
        parent,
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
        parents: [...this.subagentParents.values()].sort((left, right) => (
          `${left.projectId}\0${left.harness}\0${left.parentThreadId}`
            .localeCompare(`${right.projectId}\0${right.harness}\0${right.parentThreadId}`)
        )),
      };
      try {
        const status = await this.database.rebuildThreadStateShadow(request);
        if (status.state === "failed") this.log(`${status.errorText ?? "Thread-state shadow projection failed."} Serving authority remains unchanged.`);
      } catch {
        this.log("Thread-state shadow projection failed before durable status could be recorded; serving authority remains unchanged.");
      }
    }
  }
}
