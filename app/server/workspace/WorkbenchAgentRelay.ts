/*
 * Exports:
 * - default WorkbenchAgentRelay: answer daemons' agent relay requests (resolve targets, read summaries, forward calls to their target
 *   daemon, fetch peer branches) stamping each with the daemon whose connection asked; describe this app's reach to every daemon;
 *   and carry out users' network approvals and grant edits, which write grants onto the daemons that enforce them.
 */
import type { DaemonId } from "workbench-shared/workbench/identity";
import type { WorkbenchLogicalProject, WorkbenchLogicalProjectLocation } from "workbench-shared/types";
import {
  NetworkAccessDecision, NetworkGrant, type NetworkGrantCreate, type NetworkTarget,
} from "workbench-shared/workbench/network/network-grants";
import type {
  RelayOutcome, RelayPresence, RelayRemoteSummary, RelayRequest, RelayResolved, RelayResolveTarget,
} from "workbench-shared/workbench/network/network-relay-contracts";
import { ProjectFolderAddress } from "workbench-shared/workbench/project/project-folder-address";
import type { LocatedThreadSummary } from "workbench-shared/workbench/thread/thread-summary";
import type { WorkspaceNetworkGrantsList, WorkspaceNetworkGrantsRequest } from "workbench-shared/workbench/workspace/workspace-commands";
import type { GitPeerFetchOutcome, GitPeerFetchQuestion } from "workbench-shared/workbench/git/git-peer-contracts";
import type WorkbenchDaemonSource from "./WorkbenchDaemonSource";
import type WorkbenchWorkspaceThreads from "./WorkbenchWorkspaceThreads";

/** How long a relayed call may wait for a sleeping or reconnecting target daemon to come up. */
const TARGET_CONNECT_TIMEOUT_MS = 30_000;

type Source = Pick<WorkbenchDaemonSource, "id" | "available" | "retain" | "subscribe" | "getSnapshot" | "observe" | "daemon" | "request">;

function bounded(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 1000);
}

export default class WorkbenchAgentRelay {
  constructor(private readonly options: {
    sources: { all(): Source[]; get(id: DaemonId): Source | null };
    threads: Pick<WorkbenchWorkspaceThreads, "withThread">;
    workspace: { getSnapshot(): { projects: readonly WorkbenchLogicalProject[] } };
    fetchPeer(daemonId: DaemonId, question: GitPeerFetchQuestion): Promise<GitPeerFetchOutcome>;
    signal: AbortSignal;
  }) {}

  /** Daemons this app can open threads on: every source it still has access to. */
  reach(): Set<DaemonId> {
    return new Set(this.options.sources.all().filter(source => source.getSnapshot().connection !== "revoked").map(source => source.id));
  }

  /** What one daemon learns from this app: its own identity, the daemons the app reaches, and whether it is only standing by. */
  presence(source: Source, standby: boolean): RelayPresence {
    const daemons = this.options.sources.all().filter(item => item.getSnapshot().connection !== "revoked")
      .map(item => ({ daemonId: item.id, hostname: item.getSnapshot().hostname }));
    return { self: { daemonId: source.id, hostname: source.getSnapshot().hostname }, standby, daemons };
  }

  /**
   * Answers one request that arrived on `origin`'s connection. `accept` stops the asking daemon's acceptance deadline once
   * this app takes the request; an `unreachable` answer still guarantees nothing ran.
   */
  async answer(origin: Source, request: RelayRequest, accept: () => void): Promise<RelayOutcome> {
    try {
      switch (request.kind) {
        case "resolve": {
          accept();
          return { kind: "answered", result: { targets: await Promise.all(request.targets.map(target => this.resolve(origin, target))) } };
        }
        case "summary": {
          accept();
          return { kind: "answered", result: { summaries: await this.summaries(request.threadIds) } };
        }
        case "gitPeerFetch": {
          accept();
          return { kind: "answered", result: await this.options.fetchPeer(origin.id, request.question) };
        }
        case "execute": {
          const target = this.options.sources.get(request.targetDaemonId);
          if (!target || target.getSnapshot().connection === "revoked") {
            return { kind: "unreachable", failure: "This Workbench app does not reach that daemon." };
          }
          // A sleeping or reconnecting target may take longer to come up than the asking daemon waits for acceptance.
          accept();
          const release = target.retain();
          try {
            try { await this.connected(target); }
            catch (error) { return { kind: "unreachable", failure: bounded(error) }; }
            // The caller's daemon and hostname come from the connection the request arrived on, never from its payload.
            const outcome = await target.daemon.network.execute({
              caller: { daemonId: origin.id, hostname: origin.getSnapshot().hostname, threadId: request.caller.threadId, title: request.caller.title },
              call: request.call,
            });
            return { kind: "answered", result: outcome };
          } finally { release(); }
        }
      }
    } catch (error) {
      return { kind: "failed", failure: bounded(error) };
    }
  }

  /** A user approved a pending network prompt: write the grant onto the target (and the reply grant back), then answer it. */
  async approve(threadId: string, requestKey: string) {
    return await this.options.threads.withThread(threadId, async (source, owner) => {
      const summary = (await this.summaries([owner.identity.threadId]))[owner.identity.threadId];
      const pending = summary?.summary.row.pendingQuestionnaire;
      const target = pending?.requestKey === requestKey ? pending.request.networkAccess?.target : undefined;
      if (!summary || !pending || !target) throw new Error("That network prompt is no longer pending.");
      const targetSource = this.options.sources.get(target.daemonId);
      if (!targetSource || targetSource.getSnapshot().connection === "revoked") {
        throw new Error("You don't have access to the daemon this agent wants to network with. Either gain access or approve this prompt from another device.");
      }
      const caller = { daemonId: source.id, hostname: source.getSnapshot().hostname, threadId: owner.identity.threadId, title: summary.summary.row.title };
      const release = targetSource.retain();
      try {
        await this.connected(targetSource);
        await targetSource.daemon.network.grants.create(grantFor(target, caller));
      } finally { release(); }
      if (target.kind === "thread") {
        // The target thread may answer the thread that reached it, and nothing more.
        await source.daemon.network.grants.create({
          kind: "message", callerDaemonId: target.daemonId, callerThreadId: target.threadId, callerHostname: target.hostname,
          callerTitle: target.title, targetThreadId: owner.identity.threadId, targetProjectId: null, targetLabel: caller.title,
        });
      }
      await source.daemon.threads.questionnaire.respond({
        projectId: owner.location.projectId, threadId: owner.identity.threadId, harness: owner.identity.harness,
        requestKey, response: NetworkAccessDecision.response(true), insertAfterItemId: null, insertAfterItemIndex: null,
      });
      return { approved: true as const };
    }, this.options.signal);
  }

  async grants(request: WorkspaceNetworkGrantsRequest): Promise<WorkspaceNetworkGrantsList | { revoked: number }> {
    if (request.kind === "list") {
      return { daemons: await Promise.all(this.options.sources.all().filter(source => source.available).map(async source => {
        try {
          return { daemonId: source.id, hostname: source.getSnapshot().hostname, grants: (await source.daemon.network.grants.list()).grants, failure: null };
        } catch (error) {
          return { daemonId: source.id, hostname: source.getSnapshot().hostname, grants: [], failure: bounded(error) };
        }
      })) };
    }
    if (request.kind === "revoke") {
      const source = this.options.sources.get(request.daemonId);
      if (!source?.available) throw new Error("That daemon is unavailable.");
      return await source.daemon.network.grants.revoke({ grantIds: request.grantIds });
    }
    const target = this.options.sources.get(request.target.daemonId);
    let revoked = 0;
    await this.options.threads.withThread(request.threadId, async (source, owner) => {
      if (target?.available) {
        revoked = (await target.daemon.network.grants.revoke({
          callerDaemonId: source.id, callerThreadId: owner.identity.threadId, need: NetworkGrant.needFor(request.target),
        })).revoked;
      }
      await source.daemon.network.revokeHistory({ threadId: owner.identity.threadId, entryId: request.entryId });
    }, this.options.signal);
    if (!target?.available) throw new Error(`${request.target.hostname} is unavailable; its grant stays until you revoke it from an app that reaches it.`);
    return { revoked };
  }

  private async resolve(origin: Source, target: RelayResolveTarget): Promise<RelayResolved> {
    try {
      if (target.kind === "thread") {
        const located = (await this.summaries([target.threadId]))[target.threadId];
        if (!located) return { kind: "failed", failure: `Thread ${target.threadId} is not on any daemon this app reaches.` };
        const location = this.location(located.daemonId, located.projectId);
        return { kind: "resolved", target: {
          kind: "thread", daemonId: located.daemonId, hostname: located.hostname, threadId: located.summary.row.identity.threadId,
          title: located.summary.row.title, projectName: location?.name ?? located.projectId,
          daemonProject: location?.project?.kind === "daemon",
        } };
      }
      const { host, folder } = ProjectFolderAddress.parseHost(target.address);
      if (target.kind === "feedback" && !folder) {
        const source = this.options.sources.all().find(item => item.getSnapshot().hostname.toLowerCase() === host.toLowerCase()
          && item.getSnapshot().connection !== "revoked");
        return source
          ? { kind: "resolved", target: { kind: "feedback", daemonId: source.id, hostname: source.getSnapshot().hostname, projectId: null, rootPath: null } }
          : { kind: "failed", failure: `No daemon this app reaches is named ${host}.` };
      }
      const project = this.logicalProject(origin.id, target.callerProjectId);
      if (!project) return { kind: "failed", failure: "The caller's folder is not part of any project this app knows." };
      const folders = project.locations.filter(location => location.project?.kind !== "daemon"
        && !(location.target.daemonId === origin.id && location.target.projectId === target.callerProjectId));
      const matches = ProjectFolderAddress.matchHost(folders, host, folder);
      const listed = folders.map(location => `${location.hostname}:${location.rootPath}`).join(", ") || "none";
      if (matches.length !== 1) {
        return { kind: "failed", failure: `${matches.length ? "Several" : "No"} folders of this project match ${target.address}; name one as <host>:<folder>. Folders: ${listed}.` };
      }
      const match = matches[0]!;
      return { kind: "resolved", target: target.kind === "folder"
        ? { kind: "folder", daemonId: match.target.daemonId, hostname: match.hostname, projectId: match.target.projectId, rootPath: match.rootPath }
        : { kind: "feedback", daemonId: match.target.daemonId, hostname: match.hostname, projectId: match.target.projectId, rootPath: match.rootPath } };
    } catch (error) {
      return { kind: "failed", failure: bounded(error) };
    }
  }

  private logicalProject(daemonId: DaemonId, projectId: string) {
    return this.options.workspace.getSnapshot().projects.find(project => project.locations.some(location =>
      location.target.daemonId === daemonId && location.target.projectId === projectId)) ?? null;
  }

  private location(daemonId: DaemonId, projectId: string): WorkbenchLogicalProjectLocation | null {
    return this.logicalProject(daemonId, projectId)?.locations.find(location =>
      location.target.daemonId === daemonId && location.target.projectId === projectId) ?? null;
  }

  /** Each thread's summary from whichever reachable daemon holds it; threads none holds read as null. */
  private async summaries(threadIds: readonly string[]): Promise<Record<string, RelayRemoteSummary | null>> {
    const result: Record<string, RelayRemoteSummary | null> = Object.fromEntries(threadIds.map(id => [id, null]));
    await Promise.all(this.options.sources.all().filter(source => source.getSnapshot().connection !== "revoked").map(async source => {
      const release = source.retain();
      try {
        await this.connected(source);
        const observed = await this.readSummaries(source, threadIds);
        for (const [threadId, located] of Object.entries(observed)) {
          if (located && !result[threadId]) result[threadId] = { ...located, daemonId: source.id, hostname: source.getSnapshot().hostname };
        }
      } catch { /* An unreachable daemon holds none of them as far as this answer goes. */ }
      finally { release(); }
    }));
    return result;
  }

  private readSummaries(source: Source, threadIds: readonly string[]) {
    return new Promise<Record<string, LocatedThreadSummary | null>>((resolve, reject) => {
      let observation: ReturnType<Source["observe"]> | null = null;
      const timer = setTimeout(() => finish(new Error("Thread summaries did not arrive in time.")), TARGET_CONNECT_TIMEOUT_MS);
      const finish = (value: Record<string, LocatedThreadSummary | null> | Error) => {
        clearTimeout(timer);
        observation?.release();
        observation = null;
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      const check = () => {
        const fact = observation?.getSnapshot();
        if (fact?.failure) finish(new Error(fact.failure));
        else if (fact?.value?.kind === "threadSummaries") finish(fact.value.summaries as Record<string, LocatedThreadSummary | null>);
      };
      observation = source.observe({ kind: "threadSummaries", threadIds: threadIds as never }, check);
      check();
    });
  }

  /** Waits until a retained source's socket is open, or fails once a sleeping or offline daemon does not come up in time. */
  private connected(source: Source) {
    if (source.available) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error(`${source.getSnapshot().hostname} did not connect in time.`)); }, TARGET_CONNECT_TIMEOUT_MS);
      const stop = source.subscribe(() => {
        if (!source.available) return;
        clearTimeout(timer);
        stop();
        resolve();
      });
    });
  }
}

function grantFor(target: NetworkTarget, caller: { daemonId: DaemonId; hostname: string; threadId: string; title: string }): NetworkGrantCreate {
  return {
    kind: target.kind, callerDaemonId: caller.daemonId, callerThreadId: caller.threadId as NetworkGrantCreate["callerThreadId"],
    callerHostname: caller.hostname, callerTitle: caller.title,
    targetThreadId: target.kind === "thread" ? target.threadId : null,
    targetProjectId: target.kind === "thread" ? null : target.projectId,
    targetLabel: NetworkGrant.targetLabel(target),
  };
}
