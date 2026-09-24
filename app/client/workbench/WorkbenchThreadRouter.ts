/*
 * Exports:
 * - WorkbenchThreadOwner/WorkbenchThreadSource: resolved UUID ownership and verified daemon transport.
 * - default WorkbenchThreadRouter: resolve draft or admitted thread UUIDs and fence their owning session.
 */
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchLogicalThreadRow } from "workbench-shared/types";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { ThreadReferenceSchema, type DaemonId, type LogicalProjectId } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchHarness } from "workbench-shared/types";
import type WorkbenchThreadClient from "./WorkbenchThreadClient";

export interface WorkbenchThreadSource {
  daemonId: DaemonId;
  daemon: WorkbenchDaemonClient;
  threads: ReturnType<typeof WorkbenchThreadClient>;
  ready(): boolean;
}

export type WorkbenchThreadOwner =
  | {
    kind: "draft";
    id: string;
    logicalProjectId: LogicalProjectId;
    location: ProjectLocationReference;
  }
  | {
    kind: "thread";
    id: string;
    harness: WorkbenchHarness;
    logicalProjectId: LogicalProjectId | null;
    location: ProjectLocationReference;
  };

type ResolvedThread = Extract<WorkbenchThreadOwner, { kind: "thread" }>;
type CachedOwner = { owner: ResolvedThread; daemon: WorkbenchDaemonClient };

export default class WorkbenchThreadRouter {
  private readonly resolved = new Map<string, CachedOwner>();
  private disposed = false;

  constructor(private readonly sources: {
    presentation(): PresentationSnapshot | null;
    rows(): readonly WorkbenchLogicalThreadRow[];
    daemons(): readonly WorkbenchThreadSource[];
    onWarning?(message: string): void;
  }) {}

  known(id: string): WorkbenchThreadOwner | null {
    this.assertActive();
    const draft = this.sources.presentation()?.drafts.find(item =>
      item.id === id && (item.phase === "unsent" || item.phase === "submitting"));
    const observed = this.sources.rows().flatMap(row => row.entry.entryKind !== "draft"
      && row.entry.identity.threadId === id ? [{ row, identity: row.entry.identity }] : []);
    const owners = new Map(observed.map(({ row, identity }) => [
      `${row.location.daemonId}/${row.location.projectId}`,
      {
        kind: "thread" as const, id, harness: identity.harness,
        logicalProjectId: row.logicalProjectId, location: row.location,
      },
    ]));
    if (owners.size > 1 || draft && owners.size) {
      throw new Error("Thread UUID has conflicting owners.");
    }
    if (draft) return {
      kind: "draft", id, logicalProjectId: draft.logicalProjectId, location: draft.target,
    };
    const observedOwner = owners.values().next().value as ResolvedThread | undefined;
    const cached = this.resolved.get(id);
    if (observedOwner && cached
      && (observedOwner.location.daemonId !== cached.owner.location.daemonId
        || observedOwner.location.projectId !== cached.owner.location.projectId
        || observedOwner.harness !== cached.owner.harness)) {
      throw new Error("Thread UUID changed its observed owner.");
    }
    if (observedOwner) return observedOwner;
    if (cached && this.sourceFor(cached.owner.location.daemonId)?.daemon === cached.daemon) {
      return cached.owner;
    }
    if (cached) this.resolved.delete(id);
    return null;
  }

  async resolve(id: string): Promise<WorkbenchThreadOwner> {
    const known = this.known(id);
    if (known?.kind === "draft") return known;
    if (known?.kind === "thread") {
      const source = this.sourceFor(known.location.daemonId);
      if (!source) throw new Error("The thread's daemon is unavailable.");
      return known;
    }
    const presentation = this.sources.presentation();
    const retained = presentation?.members.filter(member =>
      member.kind === "thread" && member.thread?.threadId === id && member.thread.location) ?? [];
    const retainedLocations = new Map(retained.map(member => [
      `${member.thread!.location.daemonId}/${member.thread!.location.projectId}`,
      member.thread!.location,
    ]));
    if (retainedLocations.size > 1) throw new Error("Thread UUID has conflicting saved owners.");
    const candidateSources = retainedLocations.size
      ? this.sources.daemons().filter(source =>
        source.daemonId === retainedLocations.values().next().value?.daemonId && source.ready())
      : this.sources.daemons().filter(source => source.ready());
    if (!candidateSources.length) throw new Error("The thread's daemon is unavailable.");
    const results = await Promise.all(candidateSources.map(async source => {
      try {
        const response = await source.daemon.threads.resolveIdentity({
          threadId: ThreadReferenceSchema.parse(id), allowProviderAdmission: false,
        });
        return { source, identity: response.data, error: null };
      } catch (error) {
        return {
          source, identity: null,
          error: error instanceof Error ? error.message.slice(0, 200) : "Identity lookup failed.",
        };
      }
    }));
    this.assertActive();
    const failures = results.filter(result => result.error);
    if (failures.length) this.sources.onWarning?.(
      `Thread identity lookup failed on ${failures.length} verified daemon${failures.length === 1 ? "" : "s"}.`,
    );
    const matches = results.filter((result): result is typeof result & {
      identity: NonNullable<typeof result.identity>;
    } => result.identity !== null);
    if (matches.length > 1) throw new Error("Thread UUID resolved on multiple daemons.");
    const match = matches[0];
    if (!match) throw new Error("Thread UUID is unavailable on verified daemons.");
    if (match.identity.threadId !== id) throw new Error("Thread identity lookup returned a different UUID.");
    const retainedLocation = retainedLocations.values().next().value;
    if (retainedLocation && (retainedLocation.daemonId !== match.source.daemonId
      || retainedLocation.projectId !== match.identity.projectId)) {
      throw new Error("Thread UUID resolved to a different saved owner.");
    }
    const location = {
      daemonId: match.source.daemonId, projectId: match.identity.projectId,
    };
    const logicalProjectId = presentation?.locations.find(item =>
      item.target.daemonId === location.daemonId
      && item.target.projectId === location.projectId)?.logicalProjectId ?? null;
    const owner: ResolvedThread = {
      kind: "thread", id: match.identity.threadId, harness: match.identity.harness,
      logicalProjectId, location,
    };
    if (!this.sourceFor(owner.location.daemonId)
      || this.sourceFor(owner.location.daemonId)?.daemon !== match.source.daemon) {
      throw new Error("The thread's daemon changed during owner resolution.");
    }
    this.resolved.set(owner.id, { owner, daemon: match.source.daemon });
    return owner;
  }

  sourceFor(daemonId: DaemonId): WorkbenchThreadSource | null {
    this.assertActive();
    const candidates = this.sources.daemons().filter(source =>
      source.daemonId === daemonId && source.ready());
    if (candidates.length > 1) throw new Error("Daemon UUID has conflicting active sessions.");
    return candidates[0] ?? null;
  }

  async withThread<Result>(id: string,
    action: (owner: ResolvedThread, source: WorkbenchThreadSource) => Promise<Result>): Promise<Result> {
    const owner = await this.resolve(id);
    if (owner.kind !== "thread") throw new Error("This UUID belongs to an unsent draft.");
    const source = this.sourceFor(owner.location.daemonId);
    if (!source) throw new Error("The thread's daemon is unavailable.");
    const result = await action(owner, source);
    if (this.sourceFor(owner.location.daemonId)?.daemon !== source.daemon) {
      throw new Error("The thread's daemon changed during the action.");
    }
    return result;
  }

  invalidateUnavailable() {
    for (const [id, cached] of this.resolved) {
      if (this.sourceFor(cached.owner.location.daemonId)?.daemon !== cached.daemon) {
        this.resolved.delete(id);
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.resolved.clear();
  }

  private assertActive() {
    if (this.disposed) throw new Error("Thread router has closed.");
  }
}
