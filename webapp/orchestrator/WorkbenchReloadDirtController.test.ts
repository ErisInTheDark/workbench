/*
 * No production exports. Tests protect full-worktree baselines, scoped refresh generations, shared-path dirt, partial advancement, and observed Markdown. Keywords: reload, dirt, Git, instructions, test.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { observeReloadInstructionSource } from "../lib/workbench/reload-source-observer";
import WorkbenchGitRepository from "../lib/workbench/git/WorkbenchGitRepository";
import type { ReloadNodeSourceState } from "./reload-node-source-map";
import WorkbenchReloadDirtController, { type WorkbenchReloadDirtControllerState } from "./WorkbenchReloadDirtController";

const run = promisify(execFile);

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((settle) => { resolve = settle; });
  return { promise, resolve };
}

class ControlledReloadDirtRepository extends WorkbenchGitRepository {
  blockedSignal: AbortSignal | undefined;
  refUpdates = 0;
  scopedTreeWrites = 0;
  private blockedTree: {
    start: () => void;
    tree: Promise<string>;
  } | null = null;

  blockNextScopedTree() {
    const started = deferred<void>();
    const tree = deferred<string>();
    this.blockedTree = {
      start: () => started.resolve(),
      tree: tree.promise,
    };
    return { release: tree.resolve, started: started.promise };
  }

  async createCommitFromTree() {
    return "snapshot-commit";
  }

  async listChangedPaths(_from: string, to: string) {
    return to === "stale-tree" ? ["webapp/shared.ts"] : [];
  }

  async readRef() {
    return "base-snapshot";
  }

  async updateRef() {
    this.refUpdates += 1;
  }

  async writeScopedWorktreeTree(_paths: string[], _baseTreeish = "HEAD", signal?: AbortSignal) {
    this.scopedTreeWrites += 1;
    const blocked = this.blockedTree;
    if (!blocked) return "fresh-tree";
    this.blockedTree = null;
    this.blockedSignal = signal;
    blocked.start();
    return await blocked.tree;
  }

  async writeWorktreeTree() {
    return "snapshot-tree";
  }
}

test("a transferred reload keeps pending scopes visible without starting stale dirt work", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-reload-dirt-transfer-"));
  const descriptor = {
    access: "agent" as const,
    description: "Core",
    destructive: false,
    paths: ["webapp/shared.ts"],
    safeAll: true,
    scope: "server:core" as const,
  };
  const state: WorkbenchReloadDirtControllerState = {
    baselines: new Map([["server:core", "base-snapshot"]]),
    descriptors: new Map([["server:core", descriptor]]),
    error: null,
    pendingScopes: ["server:core"],
    snapshotCommit: "base-snapshot",
    tail: Promise.resolve(),
  };
  const repository = new ControlledReloadDirtRepository(repoRoot);
  const controller = new WorkbenchReloadDirtController({
    getSourceState: () => ({ dependantClosure: (scopes) => [...scopes], descriptors: [descriptor] }),
    repoRoot,
    repository,
  }, state);

  try {
    await controller.start();
    assert.deepEqual(controller.getSnapshot().pendingScopes, ["server:core"]);
    assert.equal(repository.scopedTreeWrites, 0);
  } finally {
    await controller.dispose();
    await fs.rm(repoRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("user reload supersedes stale dirt work without accepting its late result", async () => {
  const descriptor = {
    access: "agent" as const,
    description: "Core",
    destructive: false,
    paths: ["webapp/shared.ts"],
    safeAll: true,
    scope: "server:core" as const,
  };
  const sourceState: ReloadNodeSourceState = {
    dependantClosure: (scopes) => [...scopes],
    descriptors: [descriptor],
  };
  const state: WorkbenchReloadDirtControllerState = {
    baselines: new Map([["server:core", "base-snapshot"]]),
    descriptors: new Map([["server:core", descriptor]]),
    error: null,
    pendingScopes: [],
    snapshotCommit: "base-snapshot",
    tail: Promise.resolve(),
  };
  const repository = new ControlledReloadDirtRepository("C:/workbench-reload-dirt-test");
  const blocked = repository.blockNextScopedTree();
  const controller = new WorkbenchReloadDirtController({
    getSourceState: () => sourceState,
    repoRoot: repository.root,
    repository,
  }, state);

  try {
    const staleRefresh = controller.refresh();
    await blocked.started;
    const staleTail = state.tail;
    const staleSignal = repository.blockedSignal;
    assert.ok(staleSignal);

    controller.beginReload(["server:core"]);

    assert.notEqual(state.tail, staleTail);
    assert.equal(staleSignal.aborted, true);
    assert.deepEqual((await controller.refresh()).pendingScopes, ["server:core"]);
    assert.equal(repository.scopedTreeWrites, 1);
    await controller.completeReload(["server:core"]);
    assert.equal(repository.refUpdates, 1);
    assert.deepEqual(controller.getSnapshot(), { dirtyScopes: [], error: null, pendingScopes: [] });

    blocked.release("stale-tree");
    await assert.rejects(staleRefresh, (error) => error === staleSignal.reason);
    assert.deepEqual(controller.getSnapshot(), { dirtyScopes: [], error: null, pendingScopes: [] });
  } finally {
    await controller.dispose();
  }
});

test("shared source dirt remains for scopes whose reload baseline did not advance", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-reload-dirt-"));
  const git = async (...args: string[]) => await run("git", args, { cwd: repoRoot });
  let controller: WorkbenchReloadDirtController | null = null;
  try {
    await git("init");
    await git("config", "user.email", "workbench@example.invalid");
    await git("config", "user.name", "Workbench test");
    await fs.mkdir(path.join(repoRoot, "webapp"));
    await fs.writeFile(path.join(repoRoot, "webapp", "shared.ts"), "export const value = 1;\n", "utf8");
    await git("add", ".");
    await git("commit", "-m", "initial");

    const descriptors = [
      { access: "agent" as const, description: "Core", destructive: false, paths: ["webapp/shared.ts"], safeAll: true, scope: "server:core" },
      { access: "agent" as const, description: "MCP", destructive: false, paths: ["webapp/shared.ts"], safeAll: true, scope: "server:mcp" },
      { access: "agent" as const, description: "Instructions", destructive: false, paths: [], safeAll: false, scope: "server:instructions" },
    ];
    const sourceState: ReloadNodeSourceState = {
      dependantClosure: (scopes) => [...scopes],
      descriptors,
    };
    controller = new WorkbenchReloadDirtController({ getSourceState: () => sourceState, repoRoot });
    await controller.start();
    await fs.writeFile(path.join(repoRoot, "webapp", "shared.ts"), "export const value = 2;\n", "utf8");
    assert.deepEqual((await controller.refresh()).dirtyScopes.map(({ scope }) => scope), ["server:core", "server:mcp"]);

    await controller.completeReload(["server:core"]);
    assert.deepEqual(controller.getSnapshot().dirtyScopes.map(({ scope }) => scope), ["server:mcp"]);

    const instructionPath = path.join(repoRoot, "webapp", "live-instruction.md");
    await fs.writeFile(instructionPath, "# live instruction\n", "utf8");
    observeReloadInstructionSource(instructionPath);
    assert.deepEqual((await controller.refresh()).dirtyScopes.map(({ scope }) => scope), ["server:mcp", "server:instructions"]);
    assert.match((await git("rev-parse", "refs/worktree/workbench/reload-snapshot")).stdout, /^[0-9a-f]{40}\s*$/u);
  } finally {
    await controller?.dispose();
    await fs.rm(repoRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("scoped refresh detects loaded source deletion and recreation across its reload baseline", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-reload-dirt-scoped-"));
  const git = async (...args: string[]) => await run("git", args, { cwd: repoRoot });
  let controller: WorkbenchReloadDirtController | null = null;
  try {
    await git("init");
    await git("config", "user.email", "workbench@example.invalid");
    await git("config", "user.name", "Workbench test");
    await fs.mkdir(path.join(repoRoot, "webapp", "components"), { recursive: true });
    const sourcePath = path.join(repoRoot, "webapp", "loaded.ts");
    const clientPath = path.join(repoRoot, "webapp", "components", "client-only.tsx");
    await fs.writeFile(sourcePath, "export const value = 1;\n", "utf8");
    await fs.writeFile(clientPath, "export const client = 1;\n", "utf8");
    await git("add", ".");
    await git("commit", "-m", "initial");

    const sourceState: ReloadNodeSourceState = {
      dependantClosure: (scopes) => [...scopes],
      descriptors: [{
        access: "agent",
        description: "Core",
        destructive: false,
        paths: ["webapp/loaded.ts"],
        safeAll: true,
        scope: "server:core",
      }],
    };
    controller = new WorkbenchReloadDirtController({ getSourceState: () => sourceState, repoRoot });
    await controller.start();

    await fs.rm(sourcePath);
    await fs.writeFile(clientPath, "export const client = 2;\n", "utf8");
    assert.deepEqual((await controller.refresh()).dirtyScopes.map(({ scope }) => scope), ["server:core"]);

    await controller.completeReload(["server:core"]);
    assert.deepEqual(controller.getSnapshot().dirtyScopes, []);

    await fs.writeFile(sourcePath, "export const value = 2;\n", "utf8");
    assert.deepEqual((await controller.refresh()).dirtyScopes.map(({ scope }) => scope), ["server:core"]);

    const cancellation = new AbortController();
    const reason = new Error("cancel dirt refresh");
    cancellation.abort(reason);
    await assert.rejects(controller.refresh(cancellation.signal), (error) => error === reason);
    assert.equal(controller.getSnapshot().error, null);
  } finally {
    await controller?.dispose();
    await fs.rm(repoRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});
