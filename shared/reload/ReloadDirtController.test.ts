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
  scopedTreeWrites = 0;
  private blockedTree: { start(): void; tree: Promise<string> } | null = null;

  blockNextScopedTree() {
    const started = deferred<void>();
    const tree = deferred<string>();
    this.blockedTree = { start: () => started.resolve(), tree: tree.promise };
    return { release: tree.resolve, started: started.promise };
  }

  async createCommitFromTree() { return "snapshot-commit"; }
  async listChangedPaths(_from: string, to: string) { return to === "stale-tree" ? ["app/core.ts"] : []; }
  async listWorktreePaths() { return []; }
  async readRef() { return "base-snapshot"; }
  async updateRef() { this.refUpdates += 1; }
  async writeWorktreeTree() { return "snapshot-tree"; }

  async writeScopedWorktreeTree(_paths: string[], _base = "HEAD", signal?: AbortSignal) {
    this.scopedTreeWrites += 1;
    const blocked = this.blockedTree;
    if (!blocked) return "fresh-tree";
    this.blockedTree = null;
    this.blockedSignal = signal;
    blocked.start();
    return await blocked.tree;
  }
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
  assert.equal(repository.scopedTreeWrites, 0);
  await controller.dispose();
});

test("a user reload aborts stale reconciliation and rejects its late result", async () => {
  const repository = new ControlledRepository();
  const blocked = repository.blockNextScopedTree();
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
  blocked.release("stale-tree");
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
  let first: ReturnType<ControlledRepository["blockNextScopedTree"]> | null = null;
  let trailing: ReturnType<ControlledRepository["blockNextScopedTree"]> | null = null;
  context.after(async () => {
    first?.release("fresh-tree");
    trailing?.release("fresh-tree");
    await controller.dispose();
  });
  await controller.start();
  assert.equal(repository.scopedTreeWrites, 1);

  first = repository.blockNextScopedTree();
  watcherEvents.observe?.("change", "app/core.ts");
  await first.started;
  for (let event = 0; event < 5; event += 1) {
    watcherEvents.observe?.("change", "app/core.ts");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  trailing = repository.blockNextScopedTree();
  first.release("fresh-tree");
  await trailing.started;
  assert.equal(repository.scopedTreeWrites, 3);
  trailing.release("fresh-tree");
  await controller.dispose();
  assert.equal(repository.scopedTreeWrites, 3);
});

async function gitFixture() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-shared-reload-dirt-"));
  const git = async (...args: string[]) => await run("git", args, { cwd: repoRoot });
  await git("init");
  await git("config", "user.email", "workbench@example.invalid");
  await git("config", "user.name", "Workbench test");
  await fs.mkdir(path.join(repoRoot, "shared"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".gitignore"), ".workbench/\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "shared", "owner.ts"), "export const value = 1;\n", "utf8");
  await git("add", ".");
  await git("commit", "-m", "initial");
  return { git, repoRoot };
}

test("Git content truth preserves unapplied owners and detects deletion plus recreation", async (context) => {
  const { git, repoRoot } = await gitFixture();
  const descriptors: ReloadDirtSourceDescriptor[] = [
    { access: "operator", description: "One", destructive: false, paths: ["shared/owner.ts"], safeAll: false, scope: "client:one" },
    { access: "operator", description: "Two", destructive: false, paths: ["shared/owner.ts"], safeAll: false, scope: "client:two" },
  ];
  const snapshotRef = "refs/worktree/workbench/shared-test-reload-snapshot";
  const controller = new ReloadDirtController({
    getSourceState: () => sourceState(descriptors),
    repoRoot,
    snapshotRef,
  });
  context.after(async () => {
    await controller.dispose();
    await fs.rm(repoRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  });
  await controller.start();

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
});

test("boundary source patterns detect unobserved files and respect exclusions", async (context) => {
  const { git, repoRoot } = await gitFixture();
  const excludedPath = path.join(repoRoot, "shared", "generated", "ignored.ts");
  await fs.mkdir(path.dirname(excludedPath), { recursive: true });
  await fs.writeFile(excludedPath, "export const ignored = 1;\n", "utf8");
  await git("add", ".");
  await git("commit", "-m", "add excluded source");

  const boundaryDescriptor: ReloadDirtSourceDescriptor = {
    access: "operator",
    boundaryPatterns: ["shared/**", "!shared/generated/**"],
    description: "Boundary",
    destructive: false,
    paths: [],
    safeAll: false,
    scope: "client:boundary",
  };
  const controller = new ReloadDirtController({
    getSourceState: () => sourceState([boundaryDescriptor]),
    repoRoot,
    snapshotRef: "refs/worktree/workbench/shared-test-boundary-snapshot",
  });
  context.after(async () => {
    await controller.dispose();
    await fs.rm(repoRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  });
  await controller.start();

  await fs.writeFile(excludedPath, "export const ignored = 2;\n", "utf8");
  assert.deepEqual((await controller.refresh()).dirtyScopes, []);

  const workerPath = path.join(repoRoot, "shared", "worker", "repository.ts");
  await fs.mkdir(path.dirname(workerPath), { recursive: true });
  await fs.writeFile(workerPath, "export const repository = 1;\n", "utf8");
  assert.deepEqual(
    (await controller.refresh()).dirtyScopes.map(({ scope }) => scope),
    ["client:boundary"],
  );
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
