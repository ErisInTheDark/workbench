/*
 * Exports:
 * - default WorkbenchGitPeerState: one folder's upstream position, peer rows, upstream pushes and pulls, captured transfer
 *   intent and device-aware outcomes, shared by every view of that folder.
 * - useGitPeerState: acquire the shared state for a folder and read its snapshot.
 * - WorkbenchGitPeerSnapshot/WorkbenchGitPeerOutcome/WorkbenchGitUpstreamOutcome: what views render.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  GitPeerTransferResultSchema, type GitPeerAddress, type GitPeerStatus, type WorkspaceGitPeers, type GitPeerTransfer,
  type GitPeerTransferResult,
} from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import type WorkbenchWorkspaceClient from "../app/WorkbenchWorkspaceClient";
import type { WorkspaceQueryHandle } from "../app/WorkbenchWorkspaceClient";

/** Partial/uncertain completion survives passive updates until the next explicit action. */
export interface WorkbenchGitPeerOutcome {
  peer: GitPeerStatus;
  action: "pull" | "send";
  mode: GitPeerTransfer["mode"];
  location: GitPeerAddress | null;
  progress: Extract<GitPeerTransferResult, { kind: "blocked" }>["progress"] | "complete";
  reason: string;
  conflicts: readonly string[];
}

/** A push or pull against the folder's upstream that needs reporting; it stays until the next upstream action. */
export interface WorkbenchGitUpstreamOutcome {
  action: "push" | "pull";
  mode: GitPeerTransfer["mode"] | null;
  /** `blocked`: the pull stopped short and an agent can finish it with `wb git integrate`. `warning`: it landed with notes. */
  kind: "failed" | "blocked" | "warning";
  reason: string;
  conflicts: readonly string[];
}

export interface WorkbenchGitPeerSnapshot {
  data: WorkspaceGitPeers | null;
  busy: { peerKey: string; action: "pull" | "send"; mode: GitPeerTransfer["mode"] } | null;
  outcome: WorkbenchGitPeerOutcome | null;
  /** One push or pull against the upstream runs at a time. */
  upstreamBusy: { action: "push" | "pull"; mode: GitPeerTransfer["mode"] | null } | null;
  upstreamOutcome: WorkbenchGitUpstreamOutcome | null;
}

const EMPTY: WorkbenchGitPeerSnapshot = { data: null, busy: null, outcome: null, upstreamBusy: null, upstreamOutcome: null };
const peerKey = (peer: GitPeerAddress) => `${peer.daemonId}/${peer.projectId}`;
const shared = new WeakMap<WorkbenchWorkspaceClient, Map<string, WorkbenchGitPeerState>>();

export default class WorkbenchGitPeerState {
  private readonly listeners = new Set<() => void>();
  private observation: WorkspaceQueryHandle<"gitPeers"> | null = null;
  private holders = 0;
  private snapshot: WorkbenchGitPeerSnapshot = EMPTY;

  private constructor(private readonly workspace: WorkbenchWorkspaceClient, readonly location: ProjectLocationReference,
    private readonly forget: (state: WorkbenchGitPeerState) => void) {}

  static acquire(workspace: WorkbenchWorkspaceClient, location: ProjectLocationReference) {
    const states = shared.get(workspace) ?? new Map();
    shared.set(workspace, states);
    const key = peerKey(location);
    const state = states.get(key) ?? new WorkbenchGitPeerState(workspace, location, retired => {
      if (states.get(key) === retired) states.delete(key);
    });
    states.set(key, state);
    state.holders++;
    state.observation ??= workspace.observe({ kind: "gitPeers", location }, () => state.changed());
    state.changed();
    let released = false;
    return {
      state,
      release: () => {
        if (released) return;
        released = true;
        state.holders--;
        state.retire();
      },
    };
  }

  private retire() {
    if (this.holders || this.snapshot.busy || this.snapshot.upstreamBusy) return;
    this.observation?.release();
    this.observation = null;
    if (!this.snapshot.outcome || this.snapshot.outcome.progress === "none") this.forget(this);
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async transfer(action: "pull" | "send", peer: GitPeerStatus, mode: GitPeerTransfer["mode"]) {
    if (this.snapshot.busy) return;
    this.publish({ ...this.snapshot, busy: { peerKey: peerKey(peer), action, mode }, outcome: null });
    let outcome: WorkbenchGitPeerOutcome | null = null;
    try {
      const conformed = conformToZodSchema(GitPeerTransferResultSchema.nullable(), await this.workspace.rpc.requestRaw({
        method: "workspace/git/peer",
        params: { action, location: this.location, peer: { daemonId: peer.daemonId, projectId: peer.projectId }, mode },
      }), null);
      if (conformed.repairedPaths.length) {
        console.warn(`Conformed peer transfer result: ${conformed.repairedPaths.map(path => path.join(".")).join(", ").slice(0, 512)}`);
      }
      const result = conformed.data;
      if (!result) throw new Error("The app returned an invalid peer transfer result.");
      if (result.kind === "blocked") {
        const affected = peerKey(result.location) === peerKey(peer) ? peer.hostname : "Selected folder";
        const prefix = result.progress === "senderUpdated"
          ? `${action === "pull" ? peer.hostname : "Selected folder"} updated; transfer still needs finishing. `
          : result.progress === "uncertain" ? "A device may already have updated; refresh and retry. " : "";
        outcome = { peer, action, mode, conflicts: result.conflicts, location: result.location,
          progress: result.progress, reason: `${prefix}${affected}: ${result.reason}` };
      } else if (result.kind === "applied" && result.warnings.length) {
        outcome = { peer, action, mode, conflicts: [], location: null, progress: "complete",
          reason: `Work integrated. ${result.warnings.join(" ")}` };
      }
    } catch (error) {
      outcome = { peer, action, mode, conflicts: [], location: null, progress: "uncertain",
        reason: `Transfer interrupted; a device may already have updated. Refresh and retry. ${error instanceof Error ? error.message : ""}` };
    }
    this.publish({ ...this.snapshot, busy: null, outcome });
    this.retire();
  }

  /** Push the folder's branch to its upstream; the upstream counts update from the ref watcher, not this response. */
  async push() {
    await this.upstream("push", null, async daemon => {
      await daemon.request("git/push", { projectId: this.location.projectId });
      return null;
    });
  }

  /** Fetch the upstream, then integrate it; counts update from the ref watcher, only problems are reported. */
  async pull(mode: GitPeerTransfer["mode"]) {
    await this.upstream("pull", mode, async daemon => {
      const result = await daemon.request("git/pull", { projectId: this.location.projectId, mode });
      if (result.kind === "blocked") {
        return { kind: "blocked", reason: result.reason ?? "The pull needs attention.", conflicts: result.conflicts };
      }
      return result.kind === "applied" && result.warnings.length
        ? { kind: "warning", reason: `Pulled. ${result.warnings.join(" ")}`, conflicts: [] } : null;
    });
  }

  private async upstream(action: "push" | "pull", mode: GitPeerTransfer["mode"] | null,
    run: (daemon: ReturnType<WorkbenchWorkspaceClient["daemon"]>) => Promise<Omit<WorkbenchGitUpstreamOutcome, "action" | "mode"> | null>) {
    if (this.snapshot.upstreamBusy) return;
    this.publish({ ...this.snapshot, upstreamBusy: { action, mode }, upstreamOutcome: null });
    let outcome: WorkbenchGitUpstreamOutcome | null = null;
    try {
      const reported = await run(this.workspace.daemon({ kind: "folder", location: this.location }));
      outcome = reported && { action, mode, ...reported };
    } catch (error) {
      const reason = (error instanceof Error ? error.message : `${action === "push" ? "Push" : "Pull"} failed.`).slice(0, 512);
      outcome = { action, mode, kind: "failed", reason, conflicts: [] };
    }
    this.publish({ ...this.snapshot, upstreamBusy: null, upstreamOutcome: outcome });
    this.retire();
  }

  private changed() {
    const data = this.observation?.getSnapshot().value?.data ?? null;
    const previous = this.snapshot.outcome;
    const current = previous && data?.peers.find(peer => peerKey(peer) === peerKey(previous.peer));
    const outcome = previous && (previous.progress !== "none"
      || current && current.ahead === previous.peer.ahead && current.behind === previous.peer.behind) ? previous : null;
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
