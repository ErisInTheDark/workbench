/*
 * Exports:
 * - default WorkbenchWorkspaceThreads: resolve demanded thread ownership from independently arriving daemon facts.
 */
import { ThreadReferenceSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type { WorkspaceThreadOwner } from "workbench-shared/workbench/workspace/workspace-observation";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type WorkbenchPresentationController from "../state/WorkbenchPresentationController";
import type WorkbenchDaemonSource from "./WorkbenchDaemonSource";
import type WorkbenchDaemonSources from "./WorkbenchDaemonSources";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";

interface Interest {
  sources: Map<DaemonId, ReturnType<WorkbenchDaemonSource["observe"]>>;
  listeners: Map<object, () => void>;
  value: WorkspaceThreadOwner;
}

export default class WorkbenchWorkspaceThreads {
  private readonly interests = new Map<string, Interest>();
  private readonly unsubscribe: Array<() => void> = [];
  private refreshing = false;
  private refreshRequested = false;

  constructor(private readonly options: {
    sources: WorkbenchDaemonSources;
    presentation: WorkbenchPresentationController;
    warn(message: string): void;
    canProject?(): boolean;
  }) {}

  start() {
    if (this.unsubscribe.length) return;
    this.unsubscribe.push(
      this.options.sources.subscribe(() => this.refresh()),
      this.options.presentation.subscribe(() => this.refresh()),
    );
  }

  observe(threadId: string, listener: () => void) {
    ThreadReferenceSchema.parse(threadId);
    let interest = this.interests.get(threadId);
    if (!interest) {
      interest = { sources: new Map(), listeners: new Map(), value: { phase: "pending", failure: null } };
      this.interests.set(threadId, interest);
    }
    const token = {};
    interest.listeners.set(token, listener);
    const retained = interest;
    this.refresh();
    return {
      getSnapshot: () => retained.value,
      release: () => {
        if (!retained.listeners.delete(token) || retained.listeners.size) return;
        this.interests.delete(threadId);
        for (const observation of retained.sources.values()) observation.release();
        retained.sources.clear();
      },
    };
  }

  async withThread<Result>(
    threadId: string,
    action: (source: WorkbenchDaemonSource, owner: Extract<WorkspaceThreadOwner, { phase: "current" }>) => Promise<Result>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    let changed = () => {};
    const observation = this.observe(threadId, () => changed());
    try {
      if (observation.getSnapshot().phase === "pending") await new Promise<void>((resolve, reject) => {
        const cleanup = () => { signal.removeEventListener("abort", abort); changed = () => {}; };
        const abort = () => { cleanup(); reject(signal.reason); };
        changed = () => {
          if (observation.getSnapshot().phase === "pending") return;
          cleanup();
          resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else changed();
      });
      signal.throwIfAborted();
      const owner = observation.getSnapshot();
      if (owner.phase !== "current") throw new Error(owner.failure ?? "Thread ownership is still loading.");
      const source = this.options.sources.get(owner.location.daemonId);
      if (!source?.available) throw new WorkbenchRpcRequestInterruptedError("The thread's daemon is unavailable; request was not sent.", false);
      return await action(source, owner);
    } finally { observation.release(); }
  }

  dispose() {
    for (const stop of this.unsubscribe.splice(0)) stop();
    for (const interest of this.interests.values()) {
      for (const observation of interest.sources.values()) observation.release();
      interest.listeners.clear();
    }
    this.interests.clear();
  }

  resumeProjection() {
    this.refresh();
  }

  private refresh() {
    if (this.options.canProject?.() === false) return;
    if (this.refreshing) { this.refreshRequested = true; return; }
    this.refreshing = true;
    try {
      do {
        this.refreshRequested = false;
        for (const [threadId, interest] of this.interests) {
          for (const source of this.options.sources.all()) {
            if (interest.sources.has(source.id)) continue;
            interest.sources.set(source.id, source.observe({
              kind: "threadIdentity", threadId: ThreadReferenceSchema.parse(threadId),
            }, () => this.refresh()));
          }
          const next = this.resolve(threadId, interest);
          if (areDeeplyEqual(next, interest.value)) continue;
          interest.value = next;
          for (const listener of [...interest.listeners.values()]) {
            try { listener(); }
            catch (error) {
              this.options.warn(`Thread owner subscriber failed: ${error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`);
            }
          }
        }
      } while (this.refreshRequested);
    } finally { this.refreshing = false; }
  }

  private resolve(threadId: string, interest: Interest): WorkspaceThreadOwner {
    const presentation = this.options.presentation.read();
    const matches: Array<Extract<WorkspaceThreadOwner, { phase: "current" }>> = [];
    let pending = !interest.sources.size;
    let failure: string | null = null;
    for (const [daemonId, observation] of interest.sources) {
      const fact = observation.getSnapshot();
      if (!fact.failure && (fact.phase === "pending" || fact.phase === "stale")) pending = true;
      failure ??= fact.failure;
      if (fact.failure) continue;
      if (fact.value?.kind !== "threadIdentity" || !fact.value.identity) continue;
      const identity = fact.value.identity;
      if (identity.threadId !== threadId) {
        return { phase: "conflict", failure: "Thread identity lookup returned a different UUID." };
      }
      const location = { daemonId, projectId: identity.projectId };
      matches.push({
        phase: "current", identity, location,
        logicalProjectId: presentation.locations.find(item =>
          item.target.daemonId === daemonId && item.target.projectId === identity.projectId)?.logicalProjectId ?? null,
      });
    }
    if (matches.length > 1) return { phase: "conflict", failure: "Thread UUID has conflicting daemon owners." };
    const match = matches[0];
    if (match) {
      const conflictingSaved = presentation.members.some(member =>
        member.kind === "thread" && member.thread?.threadId === threadId
        && (member.thread.location.daemonId !== match.location.daemonId
          || member.thread.location.projectId !== match.location.projectId));
      const conflictingDraft = presentation.drafts.some(draft =>
        draft.id === threadId && (draft.phase === "unsent" || draft.phase === "submitting"));
      if (conflictingSaved || conflictingDraft) {
        return { phase: "conflict", failure: "Thread UUID conflicts with its saved ownership." };
      }
      return match;
    }
    return pending ? { phase: "pending", failure }
      : { phase: "unavailable", failure: failure ?? "Thread UUID is unavailable on connected daemons." };
  }
}
