/*
 * Keywords: thread observation, connection, subscription, revision, disposal.
 * Exports:
 * - ThreadObservationRequest: one connection-owned thread observation.
 * - default WorkbenchThreadObservationController: own live observation registration and delivery.
 */
import type {
  WorkbenchObservedThreadTarget,
  WorkbenchThreadObservationSnapshot,
} from "workbench-shared/workbench/thread/thread-state";

export interface ThreadObservationRequest {
  projectId: string;
  subscriptionId: string;
  target: WorkbenchObservedThreadTarget;
}

interface Observation {
  connectionId: string;
  request: ThreadObservationRequest;
  phase: "opening" | "active";
  latest: WorkbenchThreadObservationSnapshot | null;
}

export default class WorkbenchThreadObservationController {
  private readonly connections = new Map<string, Map<string, Observation>>();
  private disposed = false;

  constructor(
    private readonly publish: (connectionId: string, snapshot: WorkbenchThreadObservationSnapshot) => void,
  ) {}

  async observe(
    connectionId: string,
    request: ThreadObservationRequest,
    read: () => Promise<WorkbenchThreadObservationSnapshot>,
  ): Promise<WorkbenchThreadObservationSnapshot> {
    if (this.disposed) throw new Error("Thread observations are disposed.");
    let subscriptions = this.connections.get(connectionId);
    if (!subscriptions) {
      subscriptions = new Map();
      this.connections.set(connectionId, subscriptions);
    }
    const observation: Observation = { connectionId, request, phase: "opening", latest: null };
    subscriptions.set(request.subscriptionId, observation);
    try {
      const initial = await read();
      if (!this.isCurrent(observation)) throw new Error("Thread observation was released.");
      const latest = observation.latest;
      observation.latest = latest && latest.revision >= initial.revision ? latest : initial;
      observation.phase = "active";
      if (latest && latest.revision >= initial.revision) this.publish(connectionId, observation.latest);
      return observation.latest;
    } catch (error) {
      if (this.isCurrent(observation)) this.release(connectionId, request.subscriptionId);
      throw error;
    }
  }

  update(projectId: string, read: (request: ThreadObservationRequest) => WorkbenchThreadObservationSnapshot) {
    for (const subscriptions of this.connections.values()) {
      for (const observation of subscriptions.values()) {
        if (observation.request.projectId !== projectId) continue;
        const next = read(observation.request);
        if (observation.latest && next.revision <= observation.latest.revision) continue;
        observation.latest = next;
        // Bootstrap is also admission. Never publish buffered state before admission succeeds.
        if (observation.phase === "active") this.publish(observation.connectionId, next);
      }
    }
  }

  release(connectionId: string, subscriptionId: string) {
    const subscriptions = this.connections.get(connectionId);
    subscriptions?.delete(subscriptionId);
    if (subscriptions?.size === 0) this.connections.delete(connectionId);
  }

  disconnect(connectionId: string) {
    this.connections.delete(connectionId);
  }

  hasProject(projectId: string) {
    for (const subscriptions of this.connections.values()) {
      for (const observation of subscriptions.values()) {
        if (observation.request.projectId === projectId) return true;
      }
    }
    return false;
  }

  dispose() {
    this.disposed = true;
    this.connections.clear();
  }

  private isCurrent(observation: Observation) {
    return !this.disposed
      && this.connections.get(observation.connectionId)?.get(observation.request.subscriptionId) === observation;
  }
}
