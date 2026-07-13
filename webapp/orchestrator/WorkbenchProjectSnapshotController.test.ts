/*
 * Exports:
 * - No production exports; Node tests cover bounded project snapshot caching, coalescing, deletion confirmation, mutation refresh, LRU eviction, and disposal. Keywords: project, snapshot, cache, watcher, delete, lifecycle, test.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { deleteProjectFile } from "../lib/project";
import type { ProjectSnapshot } from "../lib/types";
import WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";

class FakeWatcher {
  closed = false;
  private errorListener = () => undefined;

  constructor(
    readonly rootPath: string,
    private readonly changeListener: (eventType: string, filename: string | Buffer | null) => void,
    readonly recursive: boolean,
  ) {}

  close() {
    this.closed = true;
  }

  emitChange(filename: string) {
    this.changeListener("change", filename);
  }

  emitError() {
    this.errorListener();
  }

  on(_event: "error", listener: () => void) {
    this.errorListener = listener;
    return this;
  }
}

function deferred<TValue>() {
  let resolve = (_value: TValue) => undefined;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function createSnapshot(projectId: string): ProjectSnapshot {
  return {
    changes: {},
    projectId,
    root: projectId,
    rootPath: `C:/projects/${projectId}`,
    roots: [{ id: projectId, isPrimary: true, name: projectId, relativePath: projectId, rootPath: `C:/projects/${projectId}` }],
    tree: [{ name: "README.md", path: "README.md", type: "file" }],
    workbenchStorageRootPath: "C:/projects/workbench",
  };
}

function createRequest(method: string, url: string, body = "") {
  const request = new Readable({
    read() {
      this.push(body || null);
      if (body) this.push(null);
    },
  }) as Readable & { method: string; url: string };
  request.method = method;
  request.url = url;
  return request;
}

async function captureResponse(run: (response: object) => Promise<void>) {
  let body = "";
  let headers: Record<string, string | number> = {};
  let statusCode = 0;
  const response = {
    end(value = "") { body += String(value); },
    writeHead(nextStatusCode: number, nextHeaders: Record<string, string | number>) {
      statusCode = nextStatusCode;
      headers = nextHeaders;
    },
  };
  await run(response);
  return { body, headers, statusCode };
}

function createHarness({ maxProjectSnapshots = 4 }: { maxProjectSnapshots?: number } = {}) {
  const deletedPaths: string[] = [];
  let tracked = true;
  let now = 1_000;
  let snapshotReads = 0;
  let snapshotReader = async (projectId: string | null | undefined) => createSnapshot(projectId || "default");
  const watchers: FakeWatcher[] = [];
  const controller = new WorkbenchProjectSnapshotController({
    cacheTtlMs: 100,
    createWatcher(rootPath, listener, recursive) {
      const watcher = new FakeWatcher(rootPath, listener, recursive);
      watchers.push(watcher);
      return watcher;
    },
    maxProjectSnapshots,
    now: () => now,
    operations: {
      assertProjectFileCanBeDeleted: async () => undefined,
      createProjectEntry: async () => "created.md",
      deleteProjectFile: async (filePath) => { deletedPaths.push(filePath); },
      discoverProjects: async () => [],
      getProjectSnapshot: async (projectId) => {
        snapshotReads += 1;
        return await snapshotReader(projectId);
      },
      isGitTrackedFile: async () => tracked,
      resolveProjectFilePath: (project, requestPath) => ({
        absolutePath: `${project.root}/${requestPath}`,
        displayPath: requestPath,
        gitRoot: project.root,
        root: project.roots[0],
        rootRelativePath: requestPath,
      }),
      resolveProjectRoot: async (projectId) => ({
        id: projectId || "default",
        kind: "git" as const,
        root: `C:/projects/${projectId || "default"}`,
        rootPath: `C:/projects/${projectId || "default"}`,
        roots: [{ id: projectId || "default", name: projectId || "default", root: `C:/projects/${projectId || "default"}`, rootPath: `C:/projects/${projectId || "default"}` }],
      }),
    },
    projectsRootPath: "C:/projects",
  });
  const readTree = async (projectId: string) => await captureResponse(async (response) => {
    await controller.handleTreeHttpRequest(createRequest("GET", `/orchestrator/tree?projectId=${projectId}`) as never, response as never);
  });
  return {
    controller,
    deletedPaths,
    get snapshotReads() { return snapshotReads; },
    readTree,
    setNow(value: number) { now = value; },
    setTracked(value: boolean) { tracked = value; },
    setSnapshotReader(reader: typeof snapshotReader) { snapshotReader = reader; },
    watchers,
  };
}

test("serializes once and serves unchanged project snapshots from bounded cache", async () => {
  const harness = createHarness();
  const first = await harness.readTree("alpha");
  const second = await harness.readTree("alpha");
  assert.equal(first.headers["X-Workbench-Snapshot-Cache"], "miss");
  assert.equal(second.headers["X-Workbench-Snapshot-Cache"], "hit");
  assert.equal(harness.snapshotReads, 1);
  assert.deepEqual(JSON.parse(second.body), createSnapshot("alpha"));
  assert.equal(harness.watchers.find((watcher) => watcher.rootPath === "C:/projects")?.recursive, false);
  assert.equal(harness.watchers.find((watcher) => watcher.rootPath.endsWith("alpha"))?.recursive, true);
});

test("coalesces concurrent snapshot misses", async () => {
  const harness = createHarness();
  const gate = deferred<ProjectSnapshot>();
  harness.setSnapshotReader(async () => await gate.promise);
  const first = harness.readTree("alpha");
  const second = harness.readTree("alpha");
  gate.resolve(createSnapshot("alpha"));
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.headers["X-Workbench-Snapshot-Cache"], "miss");
  assert.equal(secondResponse.headers["X-Workbench-Snapshot-Cache"], "coalesced");
  assert.equal(harness.snapshotReads, 1);
});

test("rebuilds after a relevant watcher event", async () => {
  const harness = createHarness();
  await harness.readTree("alpha");
  const projectWatcher = harness.watchers.find((watcher) => watcher.rootPath.endsWith("alpha"));
  assert.ok(projectWatcher);
  projectWatcher.emitChange("src/file.ts");
  const refreshed = await harness.readTree("alpha");
  assert.equal(refreshed.headers["X-Workbench-Snapshot-Cache"], "miss");
  assert.equal(harness.snapshotReads, 2);
});

test("does not cache an in-flight build invalidated before completion", async () => {
  const harness = createHarness();
  await harness.readTree("alpha");
  harness.setNow(2_000);
  const gate = deferred<ProjectSnapshot>();
  harness.setSnapshotReader(async () => harness.snapshotReads === 2 ? await gate.promise : createSnapshot("alpha"));
  const staleBuild = harness.readTree("alpha");
  const projectWatcher = harness.watchers.find((watcher) => watcher.rootPath.endsWith("alpha"));
  assert.ok(projectWatcher);
  projectWatcher.emitChange("src/changed.ts");
  gate.resolve(createSnapshot("alpha"));
  await staleBuild;
  const freshBuild = await harness.readTree("alpha");
  assert.equal(freshBuild.headers["X-Workbench-Snapshot-Cache"], "miss");
  assert.equal(harness.snapshotReads, 3);
});

test("tree mutation invalidates and refreshes the serialized snapshot", async () => {
  const harness = createHarness();
  await harness.readTree("alpha");
  const response = await captureResponse(async (captured) => {
    await harness.controller.handleTreeHttpRequest(createRequest("POST", "/orchestrator/tree", JSON.stringify({
      name: "created",
      parentPath: "",
      projectId: "alpha",
      type: "file",
    })) as never, captured as never);
  });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).path, "created.md");
  assert.equal(harness.snapshotReads, 2);
  assert.equal((await harness.readTree("alpha")).headers["X-Workbench-Snapshot-Cache"], "hit");
});

test("tracked file deletion proceeds immediately and refreshes the snapshot", async () => {
  const harness = createHarness();
  await harness.readTree("alpha");
  const response = await captureResponse(async (captured) => {
    await harness.controller.handleTreeHttpRequest(createRequest("DELETE", "/orchestrator/tree", JSON.stringify({
      path: "README.md",
      projectId: "alpha",
    })) as never, captured as never);
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(harness.deletedPaths, ["README.md"]);
  assert.equal(JSON.parse(response.body).tracked, true);
  assert.equal(harness.snapshotReads, 2);
  assert.equal((await harness.readTree("alpha")).headers["X-Workbench-Snapshot-Cache"], "hit");
});

test("untracked file deletion requires explicit confirmation", async () => {
  const harness = createHarness();
  harness.setTracked(false);
  const response = await captureResponse(async (captured) => {
    await harness.controller.handleTreeHttpRequest(createRequest("DELETE", "/orchestrator/tree", JSON.stringify({
      path: "notes.md",
      projectId: "alpha",
    })) as never, captured as never);
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(harness.deletedPaths, []);
  assert.deepEqual(JSON.parse(response.body), {
    confirmationRequired: true,
    path: "notes.md",
    projectId: "alpha",
    tracked: false,
  });
});

test("confirmed untracked file deletion proceeds", async () => {
  const harness = createHarness();
  harness.setTracked(false);
  const response = await captureResponse(async (captured) => {
    await harness.controller.handleTreeHttpRequest(createRequest("DELETE", "/orchestrator/tree", JSON.stringify({
      confirmUntracked: true,
      path: "notes.md",
      projectId: "alpha",
    })) as never, captured as never);
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(harness.deletedPaths, ["notes.md"]);
  assert.equal(JSON.parse(response.body).tracked, false);
});

test("project deletion rejects directory targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-delete-test-"));
  await fs.mkdir(path.join(root, "folder"));
  try {
    await assert.rejects(deleteProjectFile("folder", root), /Only files can be deleted/);
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("LRU eviction and disposal close owned watchers", async () => {
  const harness = createHarness({ maxProjectSnapshots: 1 });
  await harness.readTree("alpha");
  const alphaWatcher = harness.watchers.find((watcher) => watcher.rootPath.endsWith("alpha"));
  await harness.readTree("beta");
  assert.equal(alphaWatcher?.closed, true);
  const betaWatcher = harness.watchers.find((watcher) => watcher.rootPath.endsWith("beta"));
  harness.controller.dispose();
  assert.equal(betaWatcher?.closed, true);
});
