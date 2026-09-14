/*
 * Exports:
 * - ThreadObservationState: explicit availability of one observed thread family.
 * - ThreadObservationTransport: shared socket request boundary.
 * - getThreadObservationKey: stable project/root-family key.
 * - default ThreadObservationController: share consumer-owned observations and fence retired replies.
 */
import { WorkbenchThreadObservationResultSchema, WorkbenchThreadObservationSnapshotSchema, type WorkbenchThreadRouteTarget, type WorkbenchThreadObservationSnapshot } from "workbench-shared/workbench/thread/thread-state";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import { z } from "zod";
import type { WorkbenchSubagentSummary } from "workbench-shared/types";

type WorkbenchObservedThreadTarget = Exclude<WorkbenchThreadRouteTarget, { kind: "new" | "draft" }>;

export interface ThreadObservationState {
  status: "idle" | "loading" | "ready" | "absent" | "failed";
  observation: WorkbenchThreadObservationSnapshot | null;
  error: string | null;
}

export interface ThreadObservationTransport {
  request: (method: string, params: object) => Promise<unknown>;
}

export function getThreadObservationKey(projectId: string, target: WorkbenchObservedThreadTarget) {
  return `${projectId}\0${target.kind === "subagent" ? target.parentThreadId : target.threadId}`;
}

const idle: ThreadObservationState = { status: "idle", observation: null, error: null };
const SubscriptionEnvelopeSchema = z.object({ subscriptionId: z.uuid() }).strip();
interface Observation {
  projectId: string;
  target: WorkbenchObservedThreadTarget;
  consumers: Set<() => void>;
  subscriptionId: string | null;
  state: ThreadObservationState;
}

export default class ThreadObservationController {
  private readonly observations = new Map<string, Observation>();
  private readonly listeners = new Set<() => void>();
  private connected = true;
  private disposed = false;

  constructor(private readonly transport: ThreadObservationTransport) {}

  acquire(projectId: string, target: WorkbenchObservedThreadTarget, listener: () => void = () => {}) {
    if (this.disposed) throw new Error("Thread observations are disposed.");
    const key = getThreadObservationKey(projectId, target);
    let observation = this.observations.get(key);
    const consumer = () => listener();
    if (!observation) {
      observation = {
        projectId,
        target,
        consumers: new Set([consumer]),
        subscriptionId: null,
        state: { status: "loading", observation: null, error: null },
      };
      this.observations.set(key, observation);
      if (this.connected) void this.open(observation);
    } else observation.consumers.add(consumer);
    const record = observation;
    return { key, release: () => {
      if (!record.consumers.delete(consumer) || record.consumers.size || this.observations.get(key) !== record) return;
      const subscriptionId = record.subscriptionId;
      record.subscriptionId = null;
      this.observations.delete(key);
      if (subscriptionId) this.releaseRemote(subscriptionId);
      this.emit(record);
    } };
  }

  getSnapshot(key: string): ThreadObservationState {
    return this.observations.get(key)?.state ?? idle;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getObservations(): WorkbenchThreadObservationSnapshot[] {
    return [...this.observations.values()].flatMap(({ state }) => state.observation ? [state.observation] : []);
  }

  getSubagents(key: string): WorkbenchSubagentSummary[] {
    return this.getSnapshot(key).observation?.entries.flatMap(entry => entry.entryKind === "subagent" ? [{
      activityStatus: entry.lifecycle.kind === "working" ? "active" as const : "inactive" as const,
      createdAt: entry.createdAt, cwd: entry.cwd, directSubagentIndex: entry.directSubagentIndex,
      harness: entry.identity.harness, lastActivityAt: entry.activityAt, lifecycle: entry.lifecycle,
      name: entry.name, parentThreadId: entry.parentThreadId, pinned: entry.pinned, profileId: entry.profileId,
      profileName: entry.profileName, projectId: entry.projectId, threadId: entry.identity.threadId,
      title: entry.title, updatedAt: entry.updatedAt,
    }] : []) ?? [];
  }

  accept(input: unknown) {
    const parsed = WorkbenchThreadObservationSnapshotSchema.safeParse(input);
    if (!parsed.success) {
      reportClientSchemaError("Invalid live thread observation", parsed.error);
      const envelope = SubscriptionEnvelopeSchema.safeParse(input);
      const observation = envelope.success
        ? [...this.observations.values()].find(record => record.subscriptionId === envelope.data.subscriptionId)
        : null;
      if (observation) this.fail(observation, "The server returned invalid live thread state.");
      return;
    }
    const next = parsed.data;
    const observation = [...this.observations.values()].find(record => record.subscriptionId === next.subscriptionId);
    if (observation) this.install(observation, next);
  }

  disconnect() {
    this.connected = false;
    for (const observation of this.observations.values()) {
      observation.subscriptionId = null;
      observation.state = { ...observation.state, status: "loading", error: null };
      this.emit(observation);
    }
  }

  reset() {
    if (this.disposed) return;
    this.connected = true;
    for (const observation of this.observations.values()) void this.open(observation);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const observation of this.observations.values()) {
      const subscriptionId = observation.subscriptionId;
      observation.subscriptionId = null;
      if (subscriptionId) this.releaseRemote(subscriptionId);
    }
    this.observations.clear();
    this.listeners.clear();
  }

  private async open(observation: Observation) {
    if (observation.subscriptionId) this.releaseRemote(observation.subscriptionId);
    const subscriptionId = crypto.randomUUID();
    observation.subscriptionId = subscriptionId;
    observation.state = { ...observation.state, status: "loading", error: null };
    this.emit(observation);
    try {
      const response = await this.transport.request("workbench/thread-state/observe", {
        projectId: observation.projectId, target: observation.target, subscriptionId, version: 1,
      });
      if (!this.isCurrent(observation, subscriptionId)) return;
      const parsed = WorkbenchThreadObservationResultSchema.safeParse(response);
      if (!parsed.success) {
        reportClientSchemaError("Invalid thread observation response", parsed.error);
        throw new Error("The server returned invalid thread state.");
      }
      this.install(observation, parsed.data.observation);
    } catch (error) {
      if (this.isCurrent(observation, subscriptionId)) this.fail(observation, error instanceof Error ? error.message : "Thread observation failed.");
    }
  }

  private install(observation: Observation, next: WorkbenchThreadObservationSnapshot) {
    if (next.subscriptionId !== observation.subscriptionId
      || next.projectId !== observation.projectId
      || getThreadObservationKey(next.projectId, next.target) !== getThreadObservationKey(observation.projectId, observation.target)) {
      this.fail(observation, "The server returned thread state for a different observation.");
      return;
    }
    if (observation.state.observation?.subscriptionId === next.subscriptionId
      && next.revision <= observation.state.observation.revision) return;
    if (next.target.kind === "provider" && next.entries.length) observation.target = next.target;
    observation.state = {
      status: next.freshness === "loading" ? "loading" : next.error ? "failed" : next.entries.length ? "ready" : "absent",
      observation: next,
      error: next.error,
    };
    this.emit(observation);
  }

  private fail(observation: Observation, message: string) {
    const subscriptionId = observation.subscriptionId;
    observation.subscriptionId = null;
    const error = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
    console.warn(`Thread observation unavailable: ${error}`);
    observation.state = { ...observation.state, status: "failed", error };
    if (subscriptionId) this.releaseRemote(subscriptionId);
    this.emit(observation);
  }

  private releaseRemote(subscriptionId: string) {
    void this.transport.request("workbench/thread-state/release", { subscriptionId }).catch(() => {
      // Closing the socket releases all server subscriptions, including an in-flight release.
      if (!this.connected) return;
      console.warn("Thread observation release failed. The connection's server subscription may remain until disconnect.");
    });
  }

  private isCurrent(observation: Observation, subscriptionId: string) {
    return !this.disposed && observation.subscriptionId === subscriptionId
      && this.observations.get(getThreadObservationKey(observation.projectId, observation.target)) === observation;
  }

  private emit(observation: Observation) {
    for (const consumer of observation.consumers) consumer();
    for (const listener of this.listeners) listener();
  }
}
