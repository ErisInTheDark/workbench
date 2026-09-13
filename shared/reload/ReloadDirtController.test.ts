/*
 * No production exports. Tests protect transferred pending state, stale-refresh cancellation, watcher coalescing, Git-backed partial baselines, deletion, and external dirt.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import ReloadDirtController, {
  type ReloadDirtControllerState,
  type ReloadDirtSourceDescriptor,
  type ReloadDirtSourceState,
} from "./ReloadDirtController.ts";
import type { ReloadDirtSnapshotRepositoryPort } from "./ReloadDirtSnapshotRepository.ts";
import { createReloadContentController, RELOAD_DIRT_FIXTURE } from "./ReloadDirt.test.fixtures.ts";
import { claimPreparedGitTestFixture } from "../workbench/git/git-test-fixture.ts";

const run = promisify(execFile);

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const descriptor: ReloadDirtSourceDescriptor = {
  access: "operator",
  description: "Core",
  destructive: false,
  paths: ["app/core.ts"],
  safeAll: false,
  scope: "client:core",
};

function sourceState(descriptors: readonly ReloadDirtSourceDescriptor[] = [descriptor]): ReloadDirtSourceState {
  return { dependantClosure: (scopes) => [...scopes], descriptors };
}

class ControlledRepository implements ReloadDirtSnapshotRepositoryPort {
  blockedSignal: AbortSignal | undefined;
  refUpdates = 0;
  worktreeReads = 0;
  private blockedRead: { changes: Promise<string[]>; start(): void } | null = null;

  blockNextWorktreeRead() {
    const started = deferred<void>();
    const changes = deferred<string[]>();
    this.blockedRead = { changes: changes.promise, start: () => started.resolve() };
    return { release: changes.resolve, started: started.promise };
  }

  async createCommitFromTree() { return "snapshot-commit"; }
  async listWorktreeChangedPaths(_base: string, _paths: string[], signal?: AbortSignal) {
    this.worktreeReads += 1;
    const blocked = this.blockedRead;
    if (!blocked) return [];
    this.blockedRead = null;
    this.blockedSignal = signal;
    blocked.start();
    return await blocked.changes;
  }
  async listWorktreePaths() { return []; }
  async readRef() { return "base-snapshot"; }
  async updateRef() { this.refUpdates += 1; }
  async writeWorktreeTree() { return "snapshot-tree"; }
}

function transferredState(pendingScopes: string[] = []): ReloadDirtControllerState {
  return {
    baselines: new Map([["client:core", "base-snapshot"]]),
    descriptors: new Map([["client:core", descriptor]]),
    error: null,
    pendingScopes,
    snapshotCommit: "base-snapshot",
    tail: Promise.resolve(),
  };
}

test("a transferred batch stays pending without starting stale reconciliation", async () => {
  const repository = new ControlledRepository();
  const controller = new ReloadDirtController({
    getSourceState: sourceState,
    repoRoot: "C:/repo",
    repository,
    snapshotRef: "refs/worktree/workbench/test-reload-snapshot",
    watchSource: (() => ({ close: () => {}, on: () => {} })) as never,
  }, transferredState(["client:core"]));
  await controller.start();
  assert.deepEqual(controller.getSnapshot().pendingScopes, ["client:core"]);
  assert.equal(repository.worktreeReads, 0);
  await controller.dispose();
});

test("dirty scopes carry dependant metadata from the source graph owner", async () => {
  const repository = new ControlledRepository();
  const blocked = repository.blockNextWorktreeRead();
  const dependant: ReloadDirtSourceDescriptor = {
    ...descriptor,
    description: "Dependant",
    paths: [],
    scope: "client:dependant",
  };
  const controller = new ReloadDirtController({
    getSourceState: () => ({
      dependantClosure: (scopes) => scopes.includes("client:core")
        ? ["client:core", "client:dependant"]
        : [...scopes],
      descriptors: [descriptor, dependant],
    }),
    repoRoot: "C:/repo",
    repository,
    snapshotRef: "refs/worktree/workbench/test-reload-snapshot",
    watchSource: (() => ({ close: () => {}, on: () => {} })) as never,
  }, transferredState());
  const refresh = controller.refresh();
  await blocked.started;
  blocked.release(["app/core.ts"]);
  assert.deepEqual((await refresh).dirtyScopes, [{
    dependantScopes: ["client:dependant"],
    description: "Core",
    destructive: false,
    scope: "client:core",
  }]);
  await controller.dispose();
});

test("a user reload aborts stale reconciliation and rejects its late result", async () => {
  const repository = new ControlledRepository();
  const blocked = repository.blockNextWorktreeRead();
  const state = transferredState();
  const controller = new ReloadDirtController({
    getSourceState: sourceState,
    repoRoot: "C:/repo",
    repository,
    snapshotRef: "refs/worktree/workbench/test-reload-snapshot",
    watchSource: (() => ({ close: () => {}, on: () => {} })) as never,
  }, state);
  const staleRefresh = controller.refresh();
  await blocked.started;
  const staleSignal = repository.blockedSignal;
  assert.ok(staleSignal);
  controller.beginReload(["client:core"]);
  assert.equal(staleSignal.aborted, true);
  await controller.completeReload(["client:core"]);
  blocked.release(["app/core.ts"]);
  await assert.rejects(staleRefresh, (error) => error === staleSignal.reason);
  assert.deepEqual(controller.getSnapshot(), { dirtyScopes: [], error: null, pendingScopes: [] });
  await controller.dispose();
});

test("watcher events during reconciliation collapse into one trailing refresh", async (context) => {
  const repository = new ControlledRepository();
  const watcherEvents: {
    observe?: (eventType: string, filename: string | Buffer | null) => void;
  } = {};
  const watcher = {
    close: () => undefined,
    on: () => watcher,
  } as unknown as FSWatcher;
  const controller = new ReloadDirtController({
    getSourceState: sourceState,
    repoRoot: "C:/repo",
    repository,
    snapshotRef: "refs/worktree/workbench/test-reload-snapshot",
    watchSource: ((_root, _options, listener) => {
      watcherEvents.observe = listener as typeof watcherEvents.observe;
      return watcher;
    }) as typeof fsWatch,
  }, transferredState());
  let first: ReturnType<ControlledRepository["blockNextWorktreeRead"]> | null = null;
  let trailing: ReturnType<ControlledRepository["blockNextWorktreeRead"]> | null = null;
  context.after(async () => {
    first?.release([]);
    trailing?.release([]);
    await controller.dispose();
  });
  await controller.start();
  assert.equal(repository.worktreeReads, 1);

  first = repository.blockNextWorktreeRead();
  watcherEvents.observe?.("change", "app/core.ts");
  await first.started;
  for (let event = 0; event < 5; event += 1) {
    watcherEvents.observe?.("change", "app/core.ts");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  trailing = repository.blockNextWorktreeRead();
  first.release([]);
  await trailing.started;
  assert.equal(repository.worktreeReads, 3);
  trailing.release([]);
  await controller.dispose();
  assert.equal(repository.worktreeReads, 3);
});

async function gitFixture() {
  const { root: repoRoot, dispose, state } = await claimPreparedGitTestFixture(RELOAD_DIRT_FIXTURE);
  const git = async (...args: string[]) => await run("git", args, { cwd: repoRoot });
  return { dispose, git, repoRoot, state };
}

async function checkContentTruth(context: test.TestContext, { git, repoRoot, state }: Awaited<ReturnType<typeof gitFixture>>) {
  const snapshotRef = "refs/worktree/workbench/shared-test-reload-snapshot";
  const controller = createReloadContentController(repoRoot, "content", state.content);
  context.after(async () => {
    await controller.dispose();
  });

  const sourcePath = path.join(repoRoot, "shared", "owner.ts");
  await fs.writeFile(sourcePath, "export const value = 2;\n", "utf8");
  assert.deepEqual((await controller.refresh()).dirtyScopes.map(({ scope }) => scope), ["client:one", "client:two"]);
  await controller.completeReload(["client:one"]);
  assert.deepEqual(controller.getSnapshot().dirtyScopes.map(({ scope }) => scope), ["client:two"]);
  await controller.completeReload(["client:two"]);

  await fs.rm(sourcePath);
  assert.deepEqual((await controller.refresh()).dirtyScopes.map(({ scope }) => scope), ["client:one", "client:two"]);
  await fs.writeFile(sourcePath, "export const value = 3;\n", "utf8");
  assert.deepEqual((await controller.refresh()).dirtyScopes.map(({ scope }) => scope), ["client:one", "client:two"]);
  assert.match((await git("rev-parse", snapshotRef)).stdout, /^[0-9a-f]{40}\s*$/u);
}

async function checkBoundaryPatterns(context: test.TestContext, { repoRoot, state }: Awaited<ReturnType<typeof gitFixture>>) {
  const excludedPath = path.join(repoRoot, "shared", "generated", "ignored.ts");
  const controller = createReloadContentController(repoRoot, "boundary", state.boundary);
  context.after(async () => {
    await controller.dispose();
  });

  await fs.writeFile(excludedPath, "export const ignored = 2;\n", "utf8");
  assert.deepEqual((await controller.refresh()).dirtyScopes, []);

  const workerPath = path.join(repoRoot, "shared", "worker", "repository.ts");
  await fs.mkdir(path.dirname(workerPath), { recursive: true });
  await fs.writeFile(workerPath, "export const repository = 1;\n", "utf8");
  assert.deepEqual(
    (await controller.refresh()).dirtyScopes.map(({ scope }) => scope),
    ["client:boundary"],
  );
}

test("Git reload content shares one repository across source graphs", async (context) => {
  const target = await gitFixture();
  context.after(target.dispose);
  await context.test("boundary source patterns detect unobserved files and respect exclusions", child => checkBoundaryPatterns(child, target));
  await context.test("Git content truth preserves unapplied owners and detects deletion plus recreation", child => checkContentTruth(child, target));
});

test("external dirt remains until its owner reloads after the marker is removed", async (context) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-external-reload-dirt-"));
  const repository = new ControlledRepository();
  const marker = ".workbench/reset";
  const controller = new ReloadDirtController({
    externalDirtSources: [{ path: marker, scope: "client:core" }],
    getSourceState: sourceState,
    repoRoot,
    repository,
    snapshotRef: "refs/worktree/workbench/external-test-reload-snapshot",
    watchSource: (() => ({ close: () => {}, on: () => {} })) as never,
  }, transferredState());
  context.after(async () => {
    await controller.dispose();
    await fs.rm(repoRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  });
  await controller.start();
  await fs.mkdir(path.dirname(path.join(repoRoot, marker)), { recursive: true });
  await fs.writeFile(path.join(repoRoot, marker), "reset\n", "utf8");
  assert.deepEqual((await controller.refresh()).dirtyScopes.map(({ scope }) => scope), ["client:core"]);
  await controller.completeReload(["client:core"]);
  assert.deepEqual(controller.getSnapshot().dirtyScopes.map(({ scope }) => scope), ["client:core"]);
  await fs.rm(path.join(repoRoot, marker));
  await controller.completeReload(["client:core"]);
  assert.deepEqual(controller.getSnapshot().dirtyScopes, []);
});
