/*
 * No production exports. Tests protect transferred pending state, stale-refresh cancellation, completed-scope cleanup, watcher coalescing, Git-backed partial baselines, deletion, and dependency dirt.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import ReloadDirtController, {
  type ReloadDirtControllerOptions,
  type ReloadDirtControllerState,
  type ReloadDirtSourceDescriptor,
  type ReloadDirtSourceState,
} from "./ReloadDirtController.ts";
import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory.ts";
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
  changedPaths: string[] = [];
  refUpdates = 0;
  worktreeReads = 0;
  private blockedRead: { changes: Promise<string[]>; start(): void } | null = null;
  private worktreeReadError: Error | null = null;

  blockNextWorktreeRead() {
    const started = deferred<void>();
    const changes = deferred<string[]>();
    this.blockedRead = { changes: changes.promise, start: () => started.resolve() };
    return { release: changes.resolve, started: started.promise };
  }

  failNextWorktreeRead(error: Error) {
    this.worktreeReadError = error;
  }

  async createCommitFromTree() { return "snapshot-commit"; }
  async listWorktreeChangedPaths(_base: string, _paths: string[], signal?: AbortSignal) {
    this.worktreeReads += 1;
    if (this.worktreeReadError) {
      const error = this.worktreeReadError;
      this.worktreeReadError = null;
      throw error;
    }
    const blocked = this.blockedRead;
    if (!blocked) return this.changedPaths;
    this.blockedRead = null;
    this.blockedSignal = signal;
    blocked.start();
    return await blocked.changes;
  }
  worktreePaths: string[] = [];
  /** `${treeish ?? "worktree"}:${path}` to file text. */
  files = new Map<string, string>();
  async listWorktreePaths() { return this.worktreePaths; }
  async readFile(treeish: string | null, sourcePath: string) { return this.files.get(`${treeish ?? "worktree"}:${sourcePath}`) ?? null; }
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

/** Wanted and installed pnpm lockfiles where `app` and `daemon` each depend on one package. */
async function writeLockfiles(root: string, versions: Record<"wanted" | "installed", { app: string }>) {
  const lockfile = ({ app }: { app: string }) => [
    "lockfileVersion: '9.0'", "", "importers:", "",
    "  app:", "    dependencies:", "      left:", `        specifier: ${app}`, `        version: ${app}`, "",
    "  daemon:", "    dependencies:", "      right:", "        specifier: 1.0.0", "        version: 1.0.0", "",
    "snapshots:", "", `  left@${app}: {}`, "", "  right@1.0.0: {}", "",
  ].join("\n");
  await fs.mkdir(path.join(root, "node_modules", ".pnpm"), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), lockfile(versions.wanted));
  await fs.writeFile(path.join(root, "node_modules", ".pnpm", "lock.yaml"), lockfile(versions.installed));
}

test("internal repository churn cannot wake source watchers through recursive overflow", async (context) => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-reload-watch-boundary-");
  const repoRoot = temporary.path;
  await fs.mkdir(path.join(repoRoot, "app"));
  await fs.writeFile(path.join(repoRoot, "app", "core.ts"), "source");
  const repository = new ControlledRepository();
  const recursiveRootNotifications: Array<() => void> = [];
  const controller = new ReloadDirtController({
    getSourceState: sourceState,
    repoRoot,
    repository,
    snapshotRef: "refs/worktree/workbench/test-reload-snapshot",
    watchSource: ((root, options, listener) => {
      if (String(root) === repoRoot && typeof options === "object" && options?.recursive) {
        recursiveRootNotifications.push(() => (listener as (event: string, filename: null) => void)("change", null));
      }
      return { close() {}, on() {} } as unknown as FSWatcher;
    }) as typeof fsWatch,
  }, transferredState());
  context.after(async () => {
    await controller.dispose();
    await temporary.dispose();
  });
  await controller.start();
  const reads = repository.worktreeReads;
  for (const notify of recursiveRootNotifications) notify();
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(repository.worktreeReads, reads, "internal churn must not trigger a source comparison");
});

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

test("detaching while source subscriptions attach prevents a retired comparison", async () => {
  const repository = new ControlledRepository();
  const controller = new ReloadDirtController({
    getSourceState: sourceState,
    repoRoot: "C:/repo",
    repository,
    snapshotRef: "refs/worktree/workbench/test-reload-snapshot",
    watchSource: (() => ({ close() {}, on() {} })) as never,
  }, transferredState());
  const starting = controller.start();
  controller.detachForReload();
  await starting;
  await controller.dispose();
  assert.equal(repository.worktreeReads, 0);
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

const manifestDescriptor: ReloadDirtSourceDescriptor = {
  ...descriptor, description: "Database", paths: ["app/database.ts", "shared/releases.ts"], scope: "client:database",
};
const releases = (...versions: number[]) => versions.map(version => `release(${version}, null),`).join("\n");

function manifestController(repository: ControlledRepository) {
  return new ReloadDirtController({
    getSourceState: () => sourceState([descriptor, manifestDescriptor]),
    repoRoot: "C:/repo",
    repository,
    schemaManifests: [{ path: "shared/releases.ts", label: "database" }],
    snapshotRef: "refs/worktree/workbench/test-reload-snapshot",
    watchSource: (() => ({ close: () => {}, on: () => {} })) as never,
  }, {
    ...transferredState(),
    baselines: new Map([["client:core", "base-snapshot"], ["client:database", "base-snapshot"]]),
    descriptors: new Map([["client:core", descriptor], ["client:database", manifestDescriptor]]),
  });
}

test("a dirty manifest owner reports the migration from its loaded release to the worktree release", async () => {
  const repository = new ControlledRepository();
  repository.files.set("base-snapshot:shared/releases.ts", releases(1, 30));
  repository.files.set("worktree:shared/releases.ts", releases(1, 30, 31));
  repository.changedPaths = ["shared/releases.ts", "app/core.ts"];
  const controller = manifestController(repository);
  const snapshot = await controller.refresh();
  assert.deepEqual(snapshot.dirtyScopes.map(({ scope, migration }) => ({ scope, migration })), [
    { scope: "client:core", migration: undefined },
    { scope: "client:database", migration: { label: "database", from: 30, to: 31 } },
  ]);
  repository.changedPaths = ["app/database.ts"];
  assert.equal((await controller.refresh()).dirtyScopes[0]?.migration, undefined, "an untouched manifest never migrates");
  await controller.dispose();
});

test("prediction dirties the owners of incoming paths and reads migrations at the incoming target", async () => {
  const repository = new ControlledRepository();
  repository.files.set("base-snapshot:shared/releases.ts", releases(1, 30));
  repository.files.set("upstream:shared/releases.ts", releases(1, 30, 31, 32));
  const controller = manifestController(repository);
  await controller.start();
  assert.deepEqual(await controller.predict(["shared/releases.ts", "README.md"], "upstream"), [{
    dependantScopes: [], description: "Database", destructive: false, scope: "client:database",
    migration: { label: "database", from: 30, to: 32 },
  }]);
  assert.deepEqual(await controller.predict(["docs/notes.md"], "upstream"), []);
  await controller.dispose();
});

test("anchored process assets ignore same-named manifests in other packages, now and when predicted", async () => {
  const repository = new ControlledRepository();
  const process: ReloadDirtSourceDescriptor = {
    ...descriptor, description: "Process", destructive: true, paths: [], scope: "client:process",
    boundaryPatterns: ["app/package.json", "/package.json", "!**/node_modules/**"],
  };
  repository.worktreePaths = ["package.json", "app/package.json", "package/package.json"];
  repository.changedPaths = ["package/package.json"];
  const controller = new ReloadDirtController({
    getSourceState: () => sourceState([process]),
    repoRoot: "C:/repo",
    repository,
    snapshotRef: "refs/worktree/workbench/test-reload-snapshot",
    watchSource: (() => ({ close: () => {}, on: () => {} })) as never,
  }, { ...transferredState(), baselines: new Map([["client:process", "base-snapshot"]]), descriptors: new Map([["client:process", process]]) });
  assert.deepEqual((await controller.refresh()).dirtyScopes, []);
  assert.deepEqual(await controller.predict(["package/package.json"], "upstream"), []);
  assert.deepEqual((await controller.predict(["package.json"], "upstream")).map(({ scope }) => scope), ["client:process"]);
  await controller.dispose();
});

test("an incoming lockfile predicts the install scope even though no source path names it", async () => {
  const repository = new ControlledRepository();
  const install: ReloadDirtSourceDescriptor = {
    ...descriptor, description: "Install", destructive: true, paths: [], scope: "client:install",
  };
  const controller = new ReloadDirtController({
    dependencySources: [{ kind: "install", scope: "client:install" }],
    getSourceState: () => sourceState([descriptor, install]),
    repoRoot: "C:/repo",
    repository,
    snapshotRef: "refs/worktree/workbench/test-reload-snapshot",
    watchSource: (() => ({ close: () => {}, on: () => {} })) as never,
  }, {
    ...transferredState(), baselines: new Map([["client:core", "base-snapshot"], ["client:install", "base-snapshot"]]),
    descriptors: new Map([["client:core", descriptor], ["client:install", install]]),
  });
  assert.deepEqual((await controller.predict(["pnpm-lock.yaml"], "upstream")).map(({ scope }) => scope), ["client:install"]);
  assert.deepEqual(await controller.predict(["docs/notes.md"], "upstream"), []);
  await controller.dispose();
});

test("transferred dirt reconciles removed scope identities to the current graph", async () => {
  const repository = new ControlledRepository();
  const blocked = repository.blockNextWorktreeRead();
  const renamed = { ...descriptor, scope: "server:codex/exec" };
  const controller = new ReloadDirtController({
    getSourceState: () => ({
      dependantClosure: (scopes) => {
        const unknown = scopes.find(scope => scope !== renamed.scope);
        if (unknown) throw new Error(`Unknown reloadable feature scope: ${unknown}.`);
        return [...scopes];
      },
      descriptors: [renamed],
    }),
    repoRoot: "C:/repo",
    repository,
    snapshotRef: "refs/worktree/workbench/test-reload-snapshot",
    watchSource: (() => ({ close: () => {}, on: () => {} })) as never,
  }, transferredState());
  const refresh = controller.refresh();
  await blocked.started;
  blocked.release(["app/core.ts"]);
  assert.deepEqual((await refresh).dirtyScopes.map(({ scope }) => scope), ["server:codex/exec"]);
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

test("completed reloads drop applied Git dirt before a failed reconciliation", async (context) => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-completed-reload-dirt-");
  context.after(async () => {
    await temporary.dispose();
  });
  const repository = new ControlledRepository();
  const other = {
    ...descriptor,
    description: "Other",
    paths: ["app/other.ts"],
    scope: "client:other",
  };
  const external = {
    ...descriptor,
    description: "External",
    paths: [],
    scope: "client:external",
  };
  const descriptors = [descriptor, other, external];
  await writeLockfiles(temporary.path, { wanted: { app: "2.0.0" }, installed: { app: "1.0.0" } });
  const controller = new ReloadDirtController({
    dependencySources: [{ kind: "install", scope: external.scope }],
    getSourceState: () => ({ dependantClosure: scopes => [...scopes], descriptors }),
    repoRoot: temporary.path,
    repository,
    snapshotRef: "refs/worktree/workbench/test-reload-snapshot",
    watchSource: (() => ({ close: () => {}, on: () => {} })) as never,
  }, {
    ...transferredState(),
    baselines: new Map(descriptors.map(({ scope }) => [scope, "base-snapshot"])),
    descriptors: new Map(descriptors.map(current => [current.scope, current])),
  });
  repository.changedPaths = ["app/core.ts", "app/other.ts"];
  await controller.refresh();
  assert.deepEqual(
    controller.getSnapshot().dirtyScopes.map(({ scope }) => scope),
    ["client:core", "client:other", "client:external"],
  );

  repository.failNextWorktreeRead(new Error("transient comparison failure"));
  await controller.completeReload(["client:core", "client:external"]);

  assert.deepEqual(controller.getSnapshot(), {
    dirtyScopes: [
      {
        dependantScopes: [],
        description: "Other",
        destructive: false,
        scope: "client:other",
      },
      {
        dependantScopes: [],
        description: "External",
        destructive: false,
        scope: "client:external",
      },
    ],
    error: "transient comparison failure",
    pendingScopes: [],
  });
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

async function dependencyController(context: test.TestContext, sources: ReloadDirtControllerOptions["dependencySources"]) {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-dependency-reload-dirt-");
  const app = { ...descriptor, scope: "client:app", paths: [] };
  const daemon = { ...descriptor, scope: "client:daemon", paths: [] };
  const install = { ...descriptor, scope: "client:install", paths: [] };
  const controller = new ReloadDirtController({
    dependencySources: sources,
    getSourceState: () => sourceState([app, daemon, install]),
    repoRoot: temporary.path,
    repository: new ControlledRepository(),
    snapshotRef: "refs/worktree/workbench/dependency-test-reload-snapshot",
    watchSource: (() => ({ close: () => {}, on: () => {} })) as never,
  });
  context.after(async () => {
    await controller.dispose();
    await temporary.dispose();
  });
  return { controller, root: temporary.path };
}

const dirtyScopes = async (controller: ReloadDirtController) =>
  (await controller.refresh()).dirtyScopes.map(({ scope }) => scope);

test("install dirt clears as soon as installed dependencies catch up, without a reload", async (context) => {
  const { controller, root } = await dependencyController(context, [{ kind: "install", scope: "client:install" }]);
  await writeLockfiles(root, { wanted: { app: "1.0.0" }, installed: { app: "1.0.0" } });
  await controller.start();
  assert.deepEqual(await dirtyScopes(controller), []);
  await writeLockfiles(root, { wanted: { app: "2.0.0" }, installed: { app: "1.0.0" } });
  assert.deepEqual(await dirtyScopes(controller), ["client:install"]);
  // A manual install rewrites node_modules/.pnpm/lock.yaml; no reload of any scope happens.
  await writeLockfiles(root, { wanted: { app: "2.0.0" }, installed: { app: "2.0.0" } });
  assert.deepEqual(await dirtyScopes(controller), []);
});

test("an installed dependency change dirties only processes whose importers load it", async (context) => {
  const { controller, root } = await dependencyController(context, [
    { kind: "loaded", scope: "client:app", importers: ["app"] },
    { kind: "loaded", scope: "client:daemon", importers: ["daemon"] },
  ]);
  await writeLockfiles(root, { wanted: { app: "1.0.0" }, installed: { app: "1.0.0" } });
  await controller.start();
  assert.deepEqual(await dirtyScopes(controller), []);
  await writeLockfiles(root, { wanted: { app: "2.0.0" }, installed: { app: "2.0.0" } });
  assert.deepEqual(await dirtyScopes(controller), ["client:app"]);
  // Only a process restart, which starts from fresh state, adopts the new installed closure.
  await controller.completeReload(["client:app"]);
  assert.deepEqual(controller.getSnapshot().dirtyScopes.map(({ scope }) => scope), ["client:app"]);
});
