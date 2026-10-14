/* Exports: none; tests protect peer discovery and real cross-device integration, including partial completion. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import { GitPeerTransferSchema, type GitBranchPosition } from "workbench-shared/workbench/git/git-peer-contracts";
import type { DaemonWorkspaceQuery, WorkspaceProjects } from "workbench-shared/workbench/workspace/workspace-observation";
import WorkbenchGitPeerRelay, { GitPeerUnsupportedError, type GitPeerLocation } from "./WorkbenchGitPeerRelay";
import WorkbenchGitPeerSync from "./WorkbenchGitPeerSync";

const { default: WorkbenchGitPeerController } = createRequire(import.meta.url)(
  "../../../daemon/server/WorkbenchGitPeerController",
) as typeof import("../../../daemon/server/WorkbenchGitPeerController");

const desktop = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
const server = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002");
const own = { daemonId: desktop, projectId: ProjectIdSchema.parse("desktop-checkout") };
const peer = { daemonId: server, projectId: ProjectIdSchema.parse("server-checkout") };

function location(target: GitPeerLocation, hostname: string) {
  return { target, daemonId: target.daemonId, hostname, name: "workbench", rootPath: `/${hostname}/workbench`,
    project: { id: target.projectId, kind: "git" as const, lastCommitTimeMs: null, name: "workbench", relativePath: "",
      rootPath: `/${hostname}/workbench`, roots: [] } };
}

function harness(transferRelay?: ConstructorParameters<typeof WorkbenchGitPeerSync>[0]["relay"]) {
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
    relay: transferRelay ?? {
      fetch: (sender, receiver) => new Promise<string>((resolve, reject) => {
        fetches.push({ sender, receiver, settle: error => error ? reject(error) : resolve("") });
      }),
      integrate: async () => ({ kind: "current" }),
      inspect: async () => ({ head: sha("a"), incoming: sha("b"), ahead: 1, behind: 1 }),
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

async function checkouts(t: test.TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("peer-sync-");
  t.after(() => temporary.dispose());
  const roots = new Map([[desktop, path.join(temporary.path, "desktop")], [server, path.join(temporary.path, "server")]]);
  const execute = promisify(execFile);
  const git = async (id: DaemonId, ...args: string[]) => (await execute("git", args, {
    cwd: roots.get(id)!, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  })).stdout.trim();
  const write = (id: DaemonId, file: string, content: string) => fs.writeFile(path.join(roots.get(id)!, file), content);
  const commit = async (id: DaemonId, file: string, content: string) => {
    await write(id, file, content);
    await git(id, "add", file);
    await git(id, "commit", "-m", file);
    return git(id, "rev-parse", "HEAD");
  };
  for (const [id, root] of roots) {
    await fs.mkdir(root, { recursive: true });
    await git(id, "init", "-b", "main");
    for (const [key, value] of [["user.name", "Sync test"], ["user.email", "sync@workbench.invalid"],
      ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) await git(id, "config", key, value);
  }
  const base = await commit(desktop, "base.txt", "base\n");
  await git(server, "fetch", roots.get(desktop)!, "main");
  await git(server, "reset", "--hard", base);
  const local = await commit(desktop, "local.txt", "local\n");
  const incoming = await commit(server, "incoming.txt", "incoming\n");
  await git(desktop, "update-ref", "refs/remotes/published/main", local);
  const origins = new Map<DaemonId, string>();
  for (const [id, root] of roots) {
    const controller = new WorkbenchGitPeerController({
      resolveRoot: async () => root,
      transitions: { run: async <T>(_root: string, operation: () => Promise<T>) => operation() },
      warn: message => assert.fail(message),
    });
    const http = createServer((request, response) => {
      const routed = new URL(request.url!, "http://localhost");
      routed.searchParams.delete("wb-daemon");
      request.url = `${routed.pathname}${routed.search}`;
      void controller.handleHttpRequest(request, response);
    });
    t.after(() => new Promise<void>((resolve, reject) => {
      http.close(error => error ? reject(error) : resolve());
      http.closeAllConnections();
    }));
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    origins.set(id, `http://127.0.0.1:${address.port}`);
  }
  const relay = new WorkbenchGitPeerRelay({ sources: { get: id => ({
    id, available: true, httpOrigin: origins.get(id)!,
    retain: () => () => undefined, subscribe: () => () => undefined,
    getSnapshot: () => ({ daemonId: id, hostname: id === desktop ? "desktop" : "server", connection: "current" as const,
      generation: 1, failure: null }),
  }) } });
  t.after(() => relay.dispose());
  const observe = (port: ConstructorParameters<typeof WorkbenchGitPeerSync>[0]["relay"] = relay) => {
    const h = harness(port);
    h.sync.observe(own, () => undefined);
    h.emit(own, { branch: "main", head: local, peers: [{ ...peer, tip: incoming, ahead: 1, behind: 1 }] });
    t.after(() => h.sync.dispose());
    return h.sync;
  };
  return { roots, git, write, commit, local, incoming, relay, observe };
}

test("fast-forward pulls refuse divergence without changing either checkout", async t => {
  const f = await checkouts(t);
  let integrations = 0;
  const result = await f.observe({
    fetch: (...args) => f.relay.fetch(...args),
    inspect: (...args) => f.relay.inspect(...args),
    integrate: (...args) => {
      integrations++;
      return f.relay.integrate(...args);
    },
  }).transfer(GitPeerTransferSchema.parse({
    action: "pull", location: own, peer, mode: "fastForward",
  }));
  assert.equal(result.kind, "blocked");
  if (result.kind === "blocked") assert.equal(result.progress, "none");
  assert.equal(integrations, 0);
  assert.equal(await f.git(desktop, "rev-parse", "HEAD"), f.local);
  assert.equal(await f.git(server, "rev-parse", "HEAD"), f.incoming);
});

test("fast-forward pulls advance only the receiver to the existing sender commit", async t => {
  const f = await checkouts(t);
  await f.git(server, "fetch", f.roots.get(desktop)!, "main");
  await f.git(server, "merge", "--no-edit", "FETCH_HEAD");
  const incoming = await f.git(server, "rev-parse", "HEAD");
  const result = await f.observe().transfer(GitPeerTransferSchema.parse({
    action: "pull", location: own, peer, mode: "fastForward",
  }));
  assert.equal(result.kind, "applied");
  assert.equal(await f.git(desktop, "rev-parse", "HEAD"), incoming);
  assert.equal(await f.git(server, "rev-parse", "HEAD"), incoming);
});

test("rebase pulls rewrite only the sender and fast-forward the published receiver", async t => {
  const f = await checkouts(t);
  const checkpointRef = "refs/worktree/agents/claude/source/checkpoints/1";
  const checkpoint = await f.git(server, "commit-tree", await f.git(server, "rev-parse", "HEAD^{tree}"),
    "-p", f.incoming, "-m", "source checkpoint");
  await f.git(server, "update-ref", checkpointRef, checkpoint);
  const result = await f.observe().transfer({ action: "pull", location: own, peer, mode: "rebase" });
  assert.equal(result.kind, "applied");
  const head = await f.git(desktop, "rev-parse", "HEAD");
  assert.equal(head, await f.git(server, "rev-parse", "HEAD"));
  assert.equal(await f.git(desktop, "rev-parse", "HEAD^"), f.local);
  assert.notEqual(head, f.incoming);
  assert.equal(await f.git(desktop, "rev-parse", "refs/remotes/published/main"), f.local);
  assert.equal(await f.git(desktop, "show", "HEAD:incoming.txt"), "incoming");
  assert.equal(await f.git(server, "show", "HEAD:local.txt"), "local");
  assert.equal(await f.git(server, "rev-parse", `${checkpointRef}^`), head);
  assert.equal(await f.git(desktop, "for-each-ref", "--format=%(refname)", "refs/worktree/agents"), "");
});

test("merge pulls preserve published commits on both devices without moving the sender", async t => {
  const f = await checkouts(t);
  await f.git(server, "update-ref", "refs/remotes/published/main", f.incoming);
  const result = await f.observe().transfer({ action: "pull", location: own, peer, mode: "merge" });
  assert.equal(result.kind, "applied");
  assert.deepEqual((await f.git(desktop, "rev-parse", "HEAD^1", "HEAD^2")).split(/\r?\n/u), [f.local, f.incoming]);
  assert.equal(await f.git(server, "rev-parse", "HEAD"), f.incoming);
});

test("published incoming commits refuse rebase on their owner without moving either checkout", async t => {
  const f = await checkouts(t);
  await f.git(server, "update-ref", "refs/remotes/published/main", f.incoming);
  const result = await f.observe().transfer({ action: "pull", location: own, peer, mode: "rebase" });
  assert.equal(result.kind, "blocked");
  assert.deepEqual(result.kind === "blocked" && result.location, peer);
  assert.equal(await f.git(server, "rev-parse", "HEAD"), f.incoming);
  assert.equal(await f.git(desktop, "rev-parse", "HEAD"), f.local);
});

test("a receiver blocked after sender rebase retains both worktrees and retry completes without another rewrite", async t => {
  const f = await checkouts(t);
  const sync = f.observe({
    fetch: f.relay.fetch.bind(f.relay),
    inspect: f.relay.inspect.bind(f.relay),
    integrate: async (...args) => {
      const result = await f.relay.integrate(...args);
      if (args[0].daemonId === server && result.kind === "applied") await f.write(desktop, "incoming.txt", "unsaved\n");
      return result;
    },
  });
  const result = await sync.transfer({ action: "pull", location: own, peer, mode: "rebase" });
  assert.equal(result.kind, "blocked");
  assert.equal(result.kind === "blocked" && result.progress, "senderUpdated");
  const rebased = await f.git(server, "rev-parse", "HEAD");
  assert.equal(await f.git(server, "rev-parse", "HEAD^"), f.local);
  assert.equal(await f.git(desktop, "rev-parse", "HEAD"), f.local);
  assert.equal(await fs.readFile(path.join(f.roots.get(desktop)!, "incoming.txt"), "utf8"), "unsaved\n");
  await fs.unlink(path.join(f.roots.get(desktop)!, "incoming.txt"));
  assert.equal((await sync.transfer({ action: "pull", location: own, peer, mode: "rebase" })).kind, "applied");
  assert.equal(await f.git(server, "rev-parse", "HEAD"), rebased);
  assert.equal(await f.git(desktop, "rev-parse", "HEAD"), rebased);
});

test("rebase send replays this device's unpublished work onto the receiving peer", async t => {
  const f = await checkouts(t);
  await f.git(desktop, "update-ref", "-d", "refs/remotes/published/main");
  await f.git(server, "update-ref", "refs/remotes/published/main", f.incoming);
  const result = await f.observe().transfer({ action: "send", location: own, peer, mode: "rebase" });
  assert.equal(result.kind, "applied");
  assert.equal(await f.git(server, "rev-parse", "HEAD"), await f.git(desktop, "rev-parse", "HEAD"));
  assert.equal(await f.git(server, "rev-parse", "HEAD^"), f.incoming);
});

test("a lost sender acknowledgement is uncertain and retry converges from actual ancestry", async t => {
  const f = await checkouts(t);
  let drop = true;
  const sync = f.observe({
    fetch: f.relay.fetch.bind(f.relay),
    inspect: f.relay.inspect.bind(f.relay),
    integrate: async (...args) => {
      const result = await f.relay.integrate(...args);
      if (drop && args[0].daemonId === server && result.kind === "applied") {
        drop = false;
        throw new Error("Connection closed after apply.");
      }
      return result;
    },
  });
  const result = await sync.transfer({ action: "pull", location: own, peer, mode: "rebase" });
  assert.equal(result.kind, "blocked");
  assert.equal(result.kind === "blocked" && result.progress, "uncertain");
  const rebased = await f.git(server, "rev-parse", "HEAD");
  assert.notEqual(rebased, f.incoming);
  assert.equal(await f.git(desktop, "rev-parse", "HEAD"), f.local);
  assert.equal((await sync.transfer({ action: "pull", location: own, peer, mode: "rebase" })).kind, "applied");
  assert.equal(await f.git(desktop, "rev-parse", "HEAD"), rebased);
});

test("concurrent receiver commits are not rewritten after the sender has rebased", async t => {
  const f = await checkouts(t);
  let concurrent = "";
  const sync = f.observe({
    fetch: f.relay.fetch.bind(f.relay),
    inspect: f.relay.inspect.bind(f.relay),
    integrate: async (...args) => {
      const result = await f.relay.integrate(...args);
      if (args[0].daemonId === server && result.kind === "applied") {
        concurrent = await f.commit(desktop, "concurrent.txt", "concurrent\n");
      }
      return result;
    },
  });
  const result = await sync.transfer({ action: "pull", location: own, peer, mode: "rebase" });
  assert.equal(result.kind, "blocked");
  assert.equal(result.kind === "blocked" && result.progress, "senderUpdated");
  assert.equal(await f.git(desktop, "rev-parse", "HEAD"), concurrent);
  assert.equal(await f.git(server, "rev-parse", "HEAD^"), f.local);
});

test("an older sender is detected before either branch is changed", async t => {
  const f = await checkouts(t);
  const sync = f.observe({
    fetch: f.relay.fetch.bind(f.relay),
    inspect: async (...args) => {
      if (args[0].daemonId === server) throw new GitPeerUnsupportedError("Update the sender.");
      return f.relay.inspect(...args);
    },
    integrate: async () => assert.fail("No mutation before both daemons support guarded integration."),
  });
  const result = await sync.transfer({ action: "pull", location: own, peer, mode: "rebase" });
  assert.equal(result.kind, "blocked");
  assert.equal(result.kind === "blocked" && result.progress, "none");
  assert.equal(await f.git(desktop, "rev-parse", "HEAD"), f.local);
  assert.equal(await f.git(server, "rev-parse", "HEAD"), f.incoming);
});

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
