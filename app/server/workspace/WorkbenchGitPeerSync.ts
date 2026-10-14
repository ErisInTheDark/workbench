/*
 * Exports:
 * - default WorkbenchGitPeerSync: own each observed folder's peers (its logical project's other visible folders on other
 *   daemons), fetch a peer's branch whenever its HEAD moves, run Pull and Send between a folder and one peer, and fetch a
 *   named peer for a daemon's agent.
 * - WorkbenchGitPeersFact: observed peer rows and freshness.
 */
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type {
  GitBranchPosition, GitPeerAddress, GitPeerFetchOutcome, GitPeerFetchQuestion, GitPeerStatus,
  GitPeerTransfer, WorkspaceGitPeers, GitPeerTransferResult,
} from "workbench-shared/workbench/git/git-peer-contracts";
import type { WorkspaceSourcePhase } from "workbench-shared/workbench/workspace/workspace-observation";
import type { DaemonId } from "workbench-shared/workbench/identity";
import type WorkbenchDaemonSource from "./WorkbenchDaemonSource";
import type WorkbenchWorkspaceController from "./WorkbenchWorkspaceController";
import { GitPeerUnsupportedError, type GitPeerLocation } from "./WorkbenchGitPeerRelay";
import type WorkbenchGitPeerRelay from "./WorkbenchGitPeerRelay";

type Observation = ReturnType<WorkbenchDaemonSource["observe"]>;

export interface WorkbenchGitPeersFact {
  phase: WorkspaceSourcePhase;
  failure: string | null;
  data: WorkspaceGitPeers | null;
}

interface Peer extends GitPeerAddress {
  hostname: string;
  rootPath: string;
  observed: boolean;
}

interface FetchAttempt {
  head: string;
  failure: { unsupported: boolean; message: string } | null;
}

interface Entry {
  location: GitPeerLocation;
  listeners: Set<() => void>;
  peers: Peer[];
  own: { key: string; observation: Observation } | null;
  /** Each peer's own branch position, read to notice its HEAD moving. */
  remotes: Map<string, Observation>;
  /** The last fetch started per peer, keyed by the peer HEAD it chased. */
  attempts: Map<string, FetchAttempt>;
  fact: WorkbenchGitPeersFact;
  stop: Array<() => void>;
}

const peerKey = (peer: GitPeerAddress) => `${peer.daemonId}/${peer.projectId}`;

function bounded(error: unknown) {
  return (error instanceof Error ? error.message : "Peer sync failed.").replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 512);
}

export default class WorkbenchGitPeerSync {
  private readonly entries = new Map<string, Entry>();
  private readonly transfers = new Set<string>();
  private closed = false;

  constructor(private readonly options: {
    sources: {
      get(id: DaemonId): Pick<WorkbenchDaemonSource, "available" | "observe"> | null;
      subscribe(listener: () => void): () => void;
    };
    workspace: Pick<WorkbenchWorkspaceController, "getSnapshot" | "subscribe">;
    relay: Pick<WorkbenchGitPeerRelay, "fetch" | "inspect" | "integrate">;
    warn(message: string): void;
  }) {}

  private get relay() { return this.options.relay; }

  observe(target: GitPeerLocation, listener: () => void) {
    if (this.closed) throw new Error("Peer sync is reloading.");
    // Locations travel into strict daemon bodies, so only the address fields are kept.
    const location = { daemonId: target.daemonId, projectId: target.projectId };
    const key = peerKey(location);
    let entry = this.entries.get(key);
    if (!entry) {
      const created: Entry = {
        location, listeners: new Set(), peers: [], own: null, remotes: new Map(), attempts: new Map(),
        fact: { phase: "pending", failure: null, data: null }, stop: [],
      };
      entry = created;
      this.entries.set(key, created);
      created.stop.push(this.options.workspace.subscribe(() => this.refresh(created)),
        this.options.sources.subscribe(() => this.refresh(created)));
      this.refresh(created);
    }
    const retained = entry;
    retained.listeners.add(listener);
    return {
      read: () => retained.fact,
      release: () => {
        if (!retained.listeners.delete(listener) || retained.listeners.size) return;
        this.retire(retained);
      },
    };
  }

  /** Pull brings the peer's commits into the folder; Send has the peer pull from the folder. Both sides learn the result. */
  async transfer(input: GitPeerTransfer): Promise<GitPeerTransferResult> {
    if (this.closed) throw new Error("Peer sync is reloading.");
    const location = { daemonId: input.location.daemonId, projectId: input.location.projectId };
    const entry = this.entries.get(peerKey(location));
    const branch = entry?.fact.data?.branch;
    if (!entry || !branch) throw new Error("This folder's branch is not known yet.");
    if (!entry.peers.some(peer => peerKey(peer) === peerKey(input.peer))) throw new Error("That folder is not a visible peer of this one.");
    const [receiver, sender] = input.action === "pull" ? [location, input.peer] : [input.peer, location];
    const keys = [peerKey(receiver), peerKey(sender)];
    if (keys.some(key => this.transfers.has(key))) throw new Error("A transfer involving one of these folders is already running.");
    for (const key of keys) this.transfers.add(key);
    let affected = receiver;
    let progress: Extract<GitPeerTransferResult, { kind: "blocked" }>["progress"] = "none";
    const warnings: string[] = [];
    const blocked = (reason: string, conflicts: string[] = []): GitPeerTransferResult =>
      ({ kind: "blocked", location: affected, progress, reason: [reason, ...warnings].join(" ").slice(0, 1024), conflicts });
    const checkOpen = () => { if (this.closed) throw new Error("Peer sync reloaded; refresh and retry to finish."); };
    try {
      const incoming = await this.relay.fetch(sender, receiver, branch);
      checkOpen();
      const destination = await this.relay.inspect(receiver, sender, branch);
      if (destination.incoming !== incoming) return blocked("The sending branch changed during inspection; refresh and try again.");
      if (!destination.behind) return { kind: "current" };
      if (input.mode === "fastForward" && destination.ahead) {
        return blocked("Branches have diverged; choose merge or rebase.");
      }

      affected = sender;
      const sent = await this.relay.fetch(receiver, sender, branch);
      checkOpen();
      const source = await this.relay.inspect(sender, receiver, branch);
      if (sent !== destination.head || source.head !== incoming || source.incoming !== sent) {
        return blocked("A branch changed during inspection; refresh and try again.");
      }

      let target = incoming;
      if (input.mode === "rebase" && destination.ahead) {
        checkOpen();
        progress = "uncertain";
        const replay = await this.relay.integrate(sender, receiver, branch, {
          mode: "replay", expectedHead: source.head, incoming: destination.head,
        });
        if (replay.kind === "blocked") {
          progress = "none";
          return blocked(replay.reason ?? "Incoming commits cannot be rebased.", replay.conflicts);
        }
        if (replay.kind === "current") throw new Error("The sending branch changed unexpectedly; refresh and retry.");
        progress = "senderUpdated";
        warnings.push(...replay.warnings);
        target = replay.toSha;
        affected = receiver;
        checkOpen();
        if (await this.relay.fetch(sender, receiver, branch) !== target) {
          return blocked("The sender updated, then gained more commits; refresh and retry to finish.");
        }
      }

      affected = receiver;
      checkOpen();
      const priorProgress = progress;
      progress = "uncertain";
      const result = await this.relay.integrate(receiver, sender, branch, {
        mode: input.mode === "merge" ? "merge" : "fastForward", expectedHead: destination.head, incoming: target,
      });
      if (result.kind === "blocked") {
        progress = priorProgress;
        return blocked(result.reason ?? "Incoming work needs resolution.", result.conflicts);
      }
      if (result.kind === "current") return { kind: "current" };
      warnings.push(...result.warnings);
      try {
        checkOpen();
        await this.relay.fetch(receiver, sender, branch);
      } catch (error) {
        warnings.push(bounded(`Work integrated, but the peer tracking ref could not be refreshed: ${bounded(error)}`));
      }
      return { kind: "applied", mode: input.mode, fromSha: destination.head, toSha: result.toSha, warnings };
    } catch (error) {
      return blocked(bounded(error));
    } finally {
      for (const key of keys) this.transfers.delete(key);
    }
  }

  /** Answers a daemon's agent: fetch the named peer's branch into that daemon's folder and say which peer it was. */
  async fetchForAgent(daemonId: DaemonId, question: GitPeerFetchQuestion): Promise<GitPeerFetchOutcome> {
    if (this.closed) throw new Error("Peer sync is reloading.");
    const location = { daemonId, projectId: question.projectId };
    const normalize = (value: string) => value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
    const peers = this.findPeers(location);
    const folder = question.folder ? normalize(question.folder) : null;
    const matches = peers.filter(peer => peer.hostname.toLowerCase() === question.host.toLowerCase()
      && (!folder || normalize(peer.rootPath) === folder || normalize(peer.rootPath).endsWith(`/${folder}`)));
    const listed = peers.map(peer => `${peer.hostname}:${peer.rootPath}`).join(", ") || "none";
    if (!matches.length) return { kind: "failed", failure: `No visible peer folder matches ${question.host}${question.folder ? `:${question.folder}` : ""}. Peers: ${listed}.` };
    if (matches.length > 1) return { kind: "failed", failure: `Several folders on ${question.host} match; name one as <host>:<folder>. Peers: ${listed}.` };
    const peer = matches[0]!;
    const address = { daemonId: peer.daemonId, projectId: peer.projectId };
    const tip = await this.relay.fetch(address, location, question.branch);
    return { kind: "fetched", peer: address, hostname: peer.hostname, rootPath: peer.rootPath, tip };
  }

  dispose() {
    this.closed = true;
    for (const entry of this.entries.values()) this.retire(entry);
  }

  private retire(entry: Entry) {
    for (const stop of entry.stop.splice(0)) stop();
    entry.own?.observation.release();
    entry.own = null;
    for (const observation of entry.remotes.values()) observation.release();
    entry.remotes.clear();
    entry.listeners.clear();
    if (this.entries.get(peerKey(entry.location)) === entry) this.entries.delete(peerKey(entry.location));
  }

  private findPeers(location: GitPeerLocation): Peer[] {
    const project = this.options.workspace.getSnapshot().projects.find(candidate => candidate.locations.some(item =>
      item.target.daemonId === location.daemonId && item.target.projectId === location.projectId));
    return (project?.locations ?? []).filter(item => item.daemonId !== location.daemonId).map(item => ({
      daemonId: item.target.daemonId, projectId: item.target.projectId, hostname: item.hostname, rootPath: item.rootPath,
      observed: item.project !== null,
    }));
  }

  private refresh(entry: Entry) {
    if (this.closed || this.entries.get(peerKey(entry.location)) !== entry) return;
    entry.peers = this.findPeers(entry.location);
    const addresses = entry.peers.map(peer => ({ daemonId: peer.daemonId, projectId: peer.projectId }));
    const ownKey = JSON.stringify(addresses);
    const source = this.options.sources.get(entry.location.daemonId);
    if (entry.own && (entry.own.key !== ownKey || !source)) {
      entry.own.observation.release();
      entry.own = null;
    }
    if (!entry.own && source && addresses.length) {
      entry.own = { key: ownKey, observation: source.observe({
        kind: "branchPosition", projectId: entry.location.projectId, peers: addresses,
      }, () => this.refresh(entry)) };
    }
    const wanted = new Set(entry.peers.map(peerKey));
    for (const [key, observation] of entry.remotes) {
      if (wanted.has(key)) continue;
      observation.release();
      entry.remotes.delete(key);
      entry.attempts.delete(key);
    }
    for (const peer of entry.peers) {
      const key = peerKey(peer);
      const peerSource = this.options.sources.get(peer.daemonId);
      if (entry.remotes.has(key) || !peerSource) continue;
      entry.remotes.set(key, peerSource.observe({ kind: "branchPosition", projectId: peer.projectId, peers: [] },
        () => this.refresh(entry)));
    }
    this.project(entry);
  }

  private project(entry: Entry) {
    const own = entry.own?.observation.getSnapshot();
    const position = own?.value?.kind === "branchPosition" ? own.value.position : null;
    const peers = entry.peers.map(peer => this.peerStatus(entry, peer, position));
    const fact: WorkbenchGitPeersFact = !entry.peers.length
      ? { phase: "current", failure: null, data: { branch: null, peers: [] } }
      : { phase: own?.phase ?? "pending", failure: own?.failure ?? null,
        data: position || peers.length ? { branch: position?.branch ?? null, peers } : null };
    if (areDeeplyEqual(entry.fact, fact)) return;
    entry.fact = fact;
    for (const listener of [...entry.listeners]) {
      try { listener(); }
      catch (error) { this.options.warn(`Peer sync observer failed: ${bounded(error)}`); }
    }
  }

  private peerStatus(entry: Entry, peer: Peer, position: GitBranchPosition | null): GitPeerStatus {
    const base = { daemonId: peer.daemonId, projectId: peer.projectId,
      hostname: peer.hostname, rootPath: peer.rootPath, ahead: 0, behind: 0, failure: null };
    const remote = entry.remotes.get(peerKey(peer))?.getSnapshot();
    const source = this.options.sources.get(peer.daemonId);
    if (!source?.available || !peer.observed) return { ...base, state: "offline" };
    if (!remote || remote.phase === "pending" || !position) return { ...base, state: "pending" };
    const attempt = entry.attempts.get(peerKey(peer));
    if (remote.phase === "failed" || remote.phase === "unavailable") {
      // A daemon predating peer sync rejects the observation; one transfer attempt tells that apart from a real failure.
      if (position.branch) this.fetch(entry, peer, position.branch, `failed:${remote.failure ?? ""}`);
      return attempt?.failure?.unsupported ? { ...base, state: "unsupported", failure: attempt.failure.message }
        : { ...base, state: "failed", failure: remote.failure };
    }
    const theirs = remote.value?.kind === "branchPosition" ? remote.value.position : null;
    if (!theirs) return { ...base, state: "pending" };
    if (!position.branch || theirs.branch !== position.branch) return { ...base, state: "otherBranch" };
    const counted = position.peers.find(item => item.daemonId === peer.daemonId && item.projectId === peer.projectId);
    const counts = { ahead: counted?.ahead ?? 0, behind: counted?.behind ?? 0 };
    if (!theirs.head || counted?.tip === theirs.head) return { ...base, ...counts, state: "current" };
    this.fetch(entry, peer, position.branch, theirs.head);
    const failure = entry.attempts.get(peerKey(peer))?.failure;
    return failure ? { ...base, ...counts, state: failure.unsupported ? "unsupported" : "failed", failure: failure.message }
      : { ...base, ...counts, state: "pending" };
  }

  /** One fetch per peer HEAD, so a failure waits for the peer to move instead of looping. Only the tracking ref moves. */
  private fetch(entry: Entry, peer: Peer, branch: string, head: string) {
    const key = peerKey(peer);
    if (entry.attempts.get(key)?.head === head) return;
    const attempt: FetchAttempt = { head, failure: null };
    entry.attempts.set(key, attempt);
    void this.relay.fetch({ daemonId: peer.daemonId, projectId: peer.projectId }, entry.location, branch).catch(error => {
      const unsupported = error instanceof GitPeerUnsupportedError;
      attempt.failure = { unsupported, message: bounded(error) };
      if (!unsupported) this.options.warn(`Peer fetch from ${peer.hostname} failed: ${attempt.failure.message}`);
      if (entry.attempts.get(key) === attempt) this.project(entry);
    });
  }
}
