/*
 * Exports:
 * - default WorkbenchGitPeerState: one folder's peer rows plus the tab's Pull/Send in flight and last blocked outcome,
 *   shared by every view of that folder.
 * - useGitPeerState: acquire the shared state for a folder and read its snapshot.
 * - WorkbenchGitPeerSnapshot/WorkbenchGitPeerOutcome: what views render.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  GitPeerIntegrationResultSchema, type GitPeerAddress, type GitPeerStatus, type WorkspaceGitPeers,
} from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type WorkbenchWorkspaceClient from "../app/WorkbenchWorkspaceClient";
import type { WorkspaceQueryHandle } from "../app/WorkbenchWorkspaceClient";

/** A Pull or Send that did not apply, kept until the peer's counts move. */
export interface WorkbenchGitPeerOutcome {
  peer: GitPeerStatus;
  action: "pull" | "send";
  reason: string;
  conflicts: readonly string[];
  /** Failures that need an agent rather than a retry. */
  blocked: boolean;
}

export interface WorkbenchGitPeerSnapshot {
  data: WorkspaceGitPeers | null;
  busy: string | null;
  outcome: WorkbenchGitPeerOutcome | null;
}

const EMPTY: WorkbenchGitPeerSnapshot = { data: null, busy: null, outcome: null };
const peerKey = (peer: GitPeerAddress) => `${peer.daemonId}/${peer.projectId}`;
const shared = new WeakMap<WorkbenchWorkspaceClient, Map<string, { state: WorkbenchGitPeerState; holders: number }>>();

export default class WorkbenchGitPeerState {
  private readonly listeners = new Set<() => void>();
  private readonly observation: WorkspaceQueryHandle<"gitPeers">;
  private snapshot: WorkbenchGitPeerSnapshot = EMPTY;

  private constructor(private readonly workspace: WorkbenchWorkspaceClient, readonly location: ProjectLocationReference) {
    this.observation = workspace.observe({ kind: "gitPeers", location }, () => this.changed());
    this.changed();
  }

  static acquire(workspace: WorkbenchWorkspaceClient, location: ProjectLocationReference) {
    const states = shared.get(workspace) ?? new Map();
    shared.set(workspace, states);
    const key = peerKey(location);
    const entry = states.get(key) ?? { state: new WorkbenchGitPeerState(workspace, location), holders: 0 };
    states.set(key, entry);
    entry.holders++;
    let released = false;
    return {
      state: entry.state,
      release: () => {
        if (released) return;
        released = true;
        if (--entry.holders) return;
        states.delete(key);
        entry.state.observation.release();
        entry.state.listeners.clear();
      },
    };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async transfer(action: "pull" | "send", peer: GitPeerStatus) {
    if (this.snapshot.busy) return;
    this.publish({ ...this.snapshot, busy: peerKey(peer), outcome: null });
    let outcome: WorkbenchGitPeerOutcome | null = null;
    try {
      const parsed = GitPeerIntegrationResultSchema.safeParse(await this.workspace.rpc.requestRaw({
        method: "workspace/git/peer",
        params: { action, location: this.location, peer: { daemonId: peer.daemonId, projectId: peer.projectId } },
      }));
      if (!parsed.success) {
        reportClientSchemaError("Rejected peer transfer result", parsed.error);
        throw new Error("The app returned an invalid peer transfer result.");
      }
      if (parsed.data.kind === "blocked") {
        outcome = { peer, action, blocked: true, conflicts: parsed.data.conflicts,
          reason: parsed.data.reason ?? (parsed.data.conflicts.length ? "Local changes overlap incoming files." : "Integration is blocked.") };
      }
    } catch (error) {
      outcome = { peer, action, blocked: false, conflicts: [],
        reason: error instanceof Error ? error.message : "The transfer failed." };
    }
    this.publish({ ...this.snapshot, busy: null, outcome });
  }

  private changed() {
    const data = this.observation.getSnapshot().value?.data ?? null;
    const previous = this.snapshot.outcome;
    const current = previous && data?.peers.find(peer => peerKey(peer) === peerKey(previous.peer));
    // An outcome describes counts that no longer hold once the peer moves.
    const outcome = previous && current && current.ahead === previous.peer.ahead && current.behind === previous.peer.behind
      ? previous : null;
    this.publish({ ...this.snapshot, data, outcome });
  }

  private publish(next: WorkbenchGitPeerSnapshot) {
    if (areDeeplyEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

export function useGitPeerState(workspace: WorkbenchWorkspaceClient, location: ProjectLocationReference | null) {
  const daemonId = location?.daemonId ?? null;
  const projectId = location?.projectId ?? null;
  const [state, setState] = useState<WorkbenchGitPeerState | null>(null);
  useEffect(() => {
    if (!daemonId || !projectId) {
      setState(null);
      return;
    }
    const handle = WorkbenchGitPeerState.acquire(workspace, { daemonId, projectId });
    setState(handle.state);
    return () => handle.release();
  }, [daemonId, projectId, workspace]);
  const snapshot = useSyncExternalStore(state?.subscribe ?? NO_SUBSCRIPTION, state?.getSnapshot ?? READ_EMPTY, state?.getSnapshot ?? READ_EMPTY);
  return { state, snapshot };
}

const NO_SUBSCRIPTION = () => () => undefined;
const READ_EMPTY = () => EMPTY;
