/* Exports: none; tests protect peer selection from visible folders and one fetch per peer HEAD, including failures. */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type { GitBranchPosition } from "workbench-shared/workbench/git/git-peer-contracts";
import type { DaemonWorkspaceQuery, WorkspaceProjects } from "workbench-shared/workbench/workspace/workspace-observation";
import { GitPeerUnsupportedError, type GitPeerLocation } from "./WorkbenchGitPeerRelay";
import WorkbenchGitPeerSync from "./WorkbenchGitPeerSync";

const desktop = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
const server = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002");
const own = { daemonId: desktop, projectId: ProjectIdSchema.parse("desktop-checkout") };
const peer = { daemonId: server, projectId: ProjectIdSchema.parse("server-checkout") };

function location(target: GitPeerLocation, hostname: string) {
  return { target, daemonId: target.daemonId, hostname, name: "workbench", rootPath: `/${hostname}/workbench`,
    project: { id: target.projectId, kind: "git" as const, lastCommitTimeMs: null, name: "workbench", relativePath: "",
      rootPath: `/${hostname}/workbench`, roots: [] } };
}

function harness() {
  const positions = new Map<string, GitBranchPosition>();
  const listeners = new Set<() => void>();
  const fetches: Array<{ sender: GitPeerLocation; receiver: GitPeerLocation; settle(error?: Error): void }> = [];
  const projects: WorkspaceProjects = {
    projects: [{
      id: LogicalProjectIdSchema.parse("00000000-0000-4000-8000-0000000000aa"), matchKey: "remote://example.com/workbench",
      label: "workbench",
      // A second folder on the observed folder's own daemon never counts as a peer.
      locations: [location(own, "desktop"), location({ daemonId: desktop, projectId: ProjectIdSchema.parse("desktop-worktree") }, "desktop"),
        location(peer, "server")],
    }],
    observedProjects: [], summaries: {}, sources: [], catalogues: [], navigation: [],
  };
  const source = (daemonId: DaemonId) => ({
    available: true,
    observe: (query: DaemonWorkspaceQuery, listener: () => void) => {
      listeners.add(listener);
      const key = query.kind === "branchPosition" ? `${daemonId}/${query.projectId}` : "";
      return {
        getSnapshot: () => {
          const position = positions.get(key) ?? null;
          return { phase: position ? "current" as const : "pending" as const, failure: null, value: position ? {
            subscriptionId: "00000000-0000-4000-8000-0000000000ff", generation: 1, revision: 1, phase: "current" as const,
            failure: null, kind: "branchPosition" as const, position,
          } : null };
        },
        retarget: () => undefined,
        release: () => { listeners.delete(listener); },
      };
    },
  });
  const sync = new WorkbenchGitPeerSync({
    sources: { get: id => source(id), subscribe: () => () => undefined },
    workspace: { getSnapshot: () => projects, subscribe: () => () => undefined },
    relay: {
      fetch: (sender, receiver) => new Promise<string>((resolve, reject) => {
        fetches.push({ sender, receiver, settle: error => error ? reject(error) : resolve("") });
      }),
      integrate: async () => ({ kind: "current" }),
    },
    warn: () => undefined,
  });
  const emit = (key: GitPeerLocation, position: GitBranchPosition) => {
    positions.set(`${key.daemonId}/${key.projectId}`, position);
    for (const listener of [...listeners]) listener();
  };
  return { sync, fetches, emit };
}

const settled = () => new Promise(resolve => setImmediate(resolve));
const sha = (digit: string) => digit.repeat(40);

test("peers are the other daemons' visible folders, fetched once per peer HEAD even when a fetch fails", async () => {
  const { sync, fetches, emit } = harness();
  const handle = sync.observe(own, () => undefined);
  emit(own, { branch: "main", head: sha("a"), peers: [{ ...peer, tip: null, ahead: 0, behind: 0 }] });
  emit(peer, { branch: "main", head: sha("b"), peers: [] });
  assert.deepEqual(handle.read().data?.peers.map(item => [item.projectId, item.state]), [[peer.projectId, "pending"]]);
  assert.equal(fetches.length, 1);
  assert.deepEqual([fetches[0]!.sender, fetches[0]!.receiver], [peer, own]);

  emit(peer, { branch: "main", head: sha("b"), peers: [] });
  assert.equal(fetches.length, 1);
  fetches[0]!.settle(new Error("server dropped the stream"));
  await settled();
  assert.equal(handle.read().data?.peers[0]?.state, "failed");
  emit(peer, { branch: "main", head: sha("b"), peers: [] });
  assert.equal(fetches.length, 1);

  emit(peer, { branch: "main", head: sha("c"), peers: [] });
  assert.equal(fetches.length, 2);
  fetches[1]!.settle();
  await settled();
  emit(own, { branch: "main", head: sha("a"), peers: [{ ...peer, tip: sha("c"), ahead: 1, behind: 2 }] });
  assert.deepEqual(handle.read().data?.peers.map(({ state, ahead, behind }) => ({ state, ahead, behind })),
    [{ state: "current", ahead: 1, behind: 2 }]);
  handle.release();
});

test("a peer daemon predating peer transfers reads as unsupported, and other branches are never fetched", async () => {
  const { sync, fetches, emit } = harness();
  const handle = sync.observe(own, () => undefined);
  emit(own, { branch: "main", head: sha("a"), peers: [{ ...peer, tip: null, ahead: 0, behind: 0 }] });
  emit(peer, { branch: "feature", head: sha("b"), peers: [] });
  assert.equal(handle.read().data?.peers[0]?.state, "otherBranch");
  assert.equal(fetches.length, 0);

  emit(peer, { branch: "main", head: sha("b"), peers: [] });
  fetches[0]!.settle(new GitPeerUnsupportedError("Update Workbench on server to sync with it."));
  await settled();
  assert.equal(handle.read().data?.peers[0]?.state, "unsupported");
  handle.release();
});
