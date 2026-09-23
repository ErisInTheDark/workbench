/*
 * Exports:
 * - default WorkbenchThreadLaunchController: own one durable create-and-first-input attempt per immutable launch ID.
 */
import {
  WorkbenchThreadLaunchRequestSchema,
  type WorkbenchThreadLaunchRequest,
  type WorkbenchThreadLaunchLocation,
  type WorkbenchThreadLaunchState,
} from "workbench-shared/workbench/thread/thread-launch";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import WorkbenchThreadActionController, {
  WorkbenchThreadCreationNotDispatchedError,
} from "./WorkbenchThreadActionController";

export default class WorkbenchThreadLaunchController {
  private readonly active = new Map<string, Promise<WorkbenchThreadLaunchState>>();
  private accepting = true;

  constructor(private readonly owners: {
    database: Pick<WorkbenchDatabaseController, "reserveThreadLaunch" | "readThreadLaunch" | "advanceThreadLaunch">;
    projects: Pick<WorkbenchProjectCatalogController, "resolveProjectById">;
    actions: Pick<WorkbenchThreadActionController, "handle" | "createForLaunch">;
    warn(message: string): void;
  }) {}

  async launch(value: WorkbenchThreadLaunchRequest): Promise<WorkbenchThreadLaunchState> {
    if (!this.accepting) throw new Error("Thread launch owner is draining.");
    const parsed = WorkbenchThreadLaunchRequestSchema.parse(value);
    const retained = await this.owners.database.readThreadLaunch(parsed.launchId);
    if (retained && !areDeeplyEqual(retained.request, parsed)) {
      throw new Error("Launch ID belongs to a different saved intent.");
    }
    const location = retained?.location ?? await this.captureLocation(parsed.projectId);
    const state = await this.owners.database.reserveThreadLaunch(parsed, location);
    const existing = this.active.get(parsed.launchId);
    if (existing) return await existing;
    if (state.phase !== "prepared" && state.phase !== "created") return state;
    const stored = await this.owners.database.readThreadLaunch(parsed.launchId);
    if (!stored) throw new Error("Reserved launch was not readable.");
    const operation = this.run(stored.request, stored.location, state);
    this.active.set(parsed.launchId, operation);
    try { return await operation; }
    finally { if (this.active.get(parsed.launchId) === operation) this.active.delete(parsed.launchId); }
  }

  private async captureLocation(projectId: WorkbenchThreadLaunchRequest["projectId"]) {
    const project = await this.owners.projects.resolveProjectById(projectId);
    return { rootPath: project.rootPath, roots: project.roots.map(root => root.rootPath) };
  }

  async read(launchId: string) {
    return (await this.owners.database.readThreadLaunch(launchId))?.state ?? null;
  }

  hasPendingWork() { return this.active.size > 0; }

  beginRuntimeDrain() { this.accepting = false; }

  async dispose() {
    this.beginRuntimeDrain();
    const results = await Promise.allSettled([...this.active.values()]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Thread launch disposal found unsettled failures.");
  }

  private async run(request: WorkbenchThreadLaunchRequest,
    location: WorkbenchThreadLaunchLocation, initial: WorkbenchThreadLaunchState) {
    let state = initial;
    let dispatched = false;
    let createdThreadId: string | null = null;
    try {
      if (state.phase === "prepared") {
        state = await this.owners.database.advanceThreadLaunch(request.launchId, "prepared", {
          phase: "creating", launchId: request.launchId,
        });
        dispatched = true;
        const thread = await this.owners.actions.createForLaunch({
          projectId: request.projectId,
          profile: { kind: "snapshot", selection: request.profile },
          ...(request.creationContext ? { context: request.creationContext } : {}),
          ...(request.additionalWritableRoots ? { additionalWritableRoots: request.additionalWritableRoots } : {}),
        }, request.launchId, location);
        createdThreadId = thread.id;
        const recorded = await this.owners.database.readThreadLaunch(request.launchId);
        if (recorded?.state.phase !== "created" || recorded.state.threadId !== thread.id) {
          throw new Error("Created thread was not bound to its launch during identity admission.");
        }
        state = recorded.state;
      }
      if (state.phase !== "created") return state;
      const sending = await this.owners.database.advanceThreadLaunch(request.launchId, "created", {
        phase: "sending", launchId: request.launchId, threadId: state.threadId,
      });
      if (sending.phase !== "sending") throw new Error("Launch did not enter first-input dispatch.");
      state = sending;
      dispatched = true;
      const result = await this.owners.actions.handle("thread/message/submit", {
        intent: "newTurn",
        threadId: sending.threadId,
        clientMessageId: request.clientMessageId,
        input: request.firstInput,
        ...(request.messageContext ? { context: request.messageContext } : {}),
      });
      if (result.kind !== "started") throw new Error("First input returned no started turn.");
      return await this.owners.database.advanceThreadLaunch(request.launchId, "sending", {
        phase: "accepted", launchId: request.launchId, threadId: sending.threadId, turnId: result.turn.id,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 512) : "Thread launch failed.";
      if (!dispatched) throw error;
      if (error instanceof WorkbenchThreadCreationNotDispatchedError && state.phase === "creating") {
        return await this.owners.database.advanceThreadLaunch(request.launchId, "creating", {
          phase: "failed", launchId: request.launchId, reason,
        });
      }
      const unknown = { phase: "unknown" as const, launchId: request.launchId,
        threadId: "threadId" in state ? state.threadId : createdThreadId, reason };
      try {
        const retained = await this.owners.database.advanceThreadLaunch(request.launchId, state.phase, unknown);
        this.owners.warn(`Thread launch outcome is unknown; do not resend. ${reason}`);
        return retained;
      } catch (settlementError) {
        this.owners.warn(`Thread launch outcome and its durable settlement are unknown; do not resend. ${reason}`);
        throw new AggregateError([error, settlementError], "Thread launch outcome could not be persisted.");
      }
    }
  }
}
