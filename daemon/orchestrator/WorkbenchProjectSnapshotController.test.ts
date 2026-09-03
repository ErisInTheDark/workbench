/*
 * Exports:
 * - No production exports; Node tests protect project observation, best-known replay, serialized polling, change-only publication, mutation refresh, HTTP compatibility, and disposal. Keywords: project, snapshot, observe, replay, poll, watcher, lifecycle, test.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { deleteProjectFile } from "../lib/project";
import type { ProjectSnapshot } from "workbench-shared/types";
import type { WorkbenchProjectStateUpdate } from "workbench-shared/workbench/project/project-state";
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

function createSnapshot(projectId: string, fileName = "README.md"): ProjectSnapshot {
  return {
    changes: {},
    projectId,
    root: projectId,
    rootPath: `C:/projects/${projectId}`,
    roots: [{ id: projectId, isPrimary: true, name: projectId, relativePath: projectId, rootPath: `C:/projects/${projectId}` }],
    tree: [{ name: fileName, path: fileName, type: "file" }],
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

async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function createHarness({ maxProjectSnapshots = 4 }: { maxProjectSnapshots?: number } = {}) {
  const deletedPaths: string[] = [];
  const errors: string[] = [];
  let tracked = true;
  let now = 1_000;
  let snapshotReads = 0;
  let snapshotReader = async (projectId: string | null | undefined) => createSnapshot(projectId || "default");
  const resolvedProjectIds: Array<string | null | undefined> = [];
  const watchers: FakeWatcher[] = [];
  const controller = new WorkbenchProjectSnapshotController({
    cacheTtlMs: 100,
    createWatcher(rootPath, listener, recursive) {
      const watcher = new FakeWatcher(rootPath, listener, recursive);
      watchers.push(watcher);
      return watcher;
    },
    logError: (message) => { errors.push(message); },
    maxProjectSnapshots,
    now: () => now,
    operations: {
      assertProjectFileCanBeDeleted: async () => undefined,
      createProjectEntry: async () => "created.md",
      deleteProjectFile: async (filePath) => { deletedPaths.push(filePath); },
      getProjectSnapshot: async (project) => {
        snapshotReads += 1;
        return await snapshotReader(project.id);
      },
      isGitTrackedFile: async () => tracked,
      resolveProjectFilePath: (project, requestPath) => ({
        absolutePath: `${project.root}/${requestPath}`,
        displayPath: requestPath,
        gitRoot: project.root,
        root: project.roots[0],
        rootRelativePath: requestPath,
      }),
    },
    pollIntervalMs: 60_000,
    resolveProjectById: async (projectId) => {
      resolvedProjectIds.push(projectId);
      return {
        id: projectId || "default",
        kind: "git" as const,
        root: `C:/projects/${projectId || "default"}`,
        rootPath: `C:/projects/${projectId || "default"}`,
        roots: [{ id: projectId || "default", name: projectId || "default", root: `C:/projects/${projectId || "default"}`, rootPath: `C:/projects/${projectId || "default"}` }],
      };
    },
  });
  const readTree = async (projectId: string) => await captureResponse(async (response) => {
    await controller.handleTreeHttpRequest(createRequest("GET", `/orchestrator/tree?projectId=${projectId}`) as never, response as never);
  });
  return {
    controller,
    deletedPaths,
    errors,
    get snapshotReads() { return snapshotReads; },
    readTree,
    resolvedProjectIds,
    setNow(value: number) { now = value; },
    setTracked(value: boolean) { tracked = value; },
    setSnapshotReader(reader: typeof snapshotReader) { snapshotReader = reader; },
    watchers,
  };
}

test("dormant HTTP reads cache without starting project watchers", async () => {
  const harness = createHarness();
  const first = await harness.readTree("alpha");
  const second = await harness.readTree("alpha");
  assert.equal(first.headers["X-Workbench-Snapshot-Cache"], "miss");
  assert.equal(second.headers["X-Workbench-Snapshot-Cache"], "hit");
  assert.equal(harness.snapshotReads, 1);
  assert.deepEqual(harness.resolvedProjectIds, ["alpha"]);
  assert.deepEqual(JSON.parse(second.body), createSnapshot("alpha"));
  assert.equal(harness.watchers.length, 0);
});

test("coalesces concurrent dormant snapshot misses", async () => {
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
  assert.deepEqual(harness.resolvedProjectIds, ["alpha"]);
});

test("an observed project publishes only changed snapshots", async () => {
  const harness = createHarness();
  const updates: WorkbenchProjectStateUpdate[] = [];
  const stop = harness.controller.observe("alpha", (update) => updates.push(update));
  await waitFor(() => updates.length === 1, "Initial observed snapshot was not published.");
  assert.equal(harness.watchers.length, 1);
  assert.equal(harness.watchers[0]?.recursive, true);
  await harness.controller.handleRequest("alpha", { method: "workbench/thread-state/project/refresh", projectId: "alpha" });
  await waitFor(() => harness.snapshotReads === 2, "Explicit refresh did not run.");
  assert.equal(updates.length, 1);
  stop();
  harness.controller.dispose();
});

test("reading the best-known project update reuses the observed cache without another snapshot build", async () => {
  const harness = createHarness();
  const updates: WorkbenchProjectStateUpdate[] = [];
  assert.equal(harness.controller.getCurrentUpdate("alpha"), null);
  const stop = harness.controller.observe("alpha", (update) => updates.push(update));
  await waitFor(() => updates.length === 1, "Initial observed snapshot was not published.");
  const readsBeforeReplay = harness.snapshotReads;
  assert.deepEqual(harness.controller.getCurrentUpdate("alpha"), updates[0]);
  assert.equal(harness.snapshotReads, readsBeforeReplay);
  assert.equal(harness.controller.getCurrentUpdate("beta"), null);
  stop();
  harness.controller.dispose();
});

test("project observations publish only to their own project", async () => {
  const harness = createHarness();
  const alphaUpdates: WorkbenchProjectStateUpdate[] = [];
  const betaUpdates: WorkbenchProjectStateUpdate[] = [];
  const stopAlpha = harness.controller.observe("alpha", (update) => alphaUpdates.push(update));
  const stopBeta = harness.controller.observe("beta", (update) => betaUpdates.push(update));
  await waitFor(() => alphaUpdates.length === 1 && betaUpdates.length === 1, "Initial project snapshots were not published.");
  harness.setSnapshotReader(async (projectId) => createSnapshot(projectId || "default", projectId === "alpha" ? "changed.ts" : "README.md"));
  harness.watchers.find((watcher) => watcher.rootPath.endsWith("alpha") && !watcher.closed)?.emitChange("src/changed.ts");
  await waitFor(() => alphaUpdates.length === 2, "Changed alpha snapshot was not published.");
  assert.equal(betaUpdates.length, 1);
  assert.equal(alphaUpdates[1]?.projectId, "alpha");
  stopAlpha();
  stopBeta();
  harness.controller.dispose();
});

test("a watcher event during a build requests exactly one serialized follow-up", async () => {
  const harness = createHarness();
  const updates: WorkbenchProjectStateUpdate[] = [];
  const stop = harness.controller.observe("alpha", (update) => updates.push(update));
  await waitFor(() => updates.length === 1, "Initial snapshot was not published.");
  const gate = deferred<ProjectSnapshot>();
  let refreshCall = 0;
  harness.setSnapshotReader(async () => {
    refreshCall += 1;
    return refreshCall === 1 ? await gate.promise : createSnapshot("alpha", "follow-up.ts");
  });
  const watcher = harness.watchers.find((candidate) => candidate.rootPath.endsWith("alpha") && !candidate.closed);
  assert.ok(watcher);
  watcher.emitChange("src/first.ts");
  await waitFor(() => harness.snapshotReads === 2, "Watcher refresh did not start.");
  watcher.emitChange("src/second.ts");
  gate.resolve(createSnapshot("alpha", "during-build.ts"));
  await waitFor(() => harness.snapshotReads === 3 && updates.length === 3, "Serialized follow-up did not finish.");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.snapshotReads, 3);
  stop();
  harness.controller.dispose();
});

test("refresh failures keep the last snapshot, log once per streak, and retry", async () => {
  const harness = createHarness();
  const updates: WorkbenchProjectStateUpdate[] = [];
  const stop = harness.controller.observe("alpha", (update) => updates.push(update));
  await waitFor(() => updates.length === 1, "Initial snapshot was not published.");
  harness.setSnapshotReader(async () => { throw new Error("disk busy"); });
  await harness.controller.handleRequest("alpha", { method: "workbench/thread-state/project/refresh", projectId: "alpha" });
  await waitFor(() => harness.snapshotReads === 2, "First failed refresh did not run.");
  await harness.controller.handleRequest("alpha", { method: "workbench/thread-state/project/refresh", projectId: "alpha" });
  await waitFor(() => harness.snapshotReads === 3, "Second failed refresh did not run.");
  assert.equal(updates.length, 1);
  assert.equal(harness.errors.length, 1);
  harness.setSnapshotReader(async () => createSnapshot("alpha", "recovered.ts"));
  await harness.controller.handleRequest("alpha", { method: "workbench/thread-state/project/refresh", projectId: "alpha" });
  await waitFor(() => updates.length === 2, "Recovered snapshot was not published.");
  stop();
  harness.controller.dispose();
});

test("last observer disposal closes watchers and stops refresh work", async () => {
  const harness = createHarness();
  const updates: WorkbenchProjectStateUpdate[] = [];
  const stop = harness.controller.observe("alpha", (update) => updates.push(update));
  await waitFor(() => updates.length === 1, "Initial snapshot was not published.");
  const watcher = harness.watchers[0];
  const readsBeforeStop = harness.snapshotReads;
  stop();
  assert.equal(watcher?.closed, true);
  watcher?.emitChange("src/after-stop.ts");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.snapshotReads, readsBeforeStop);
  harness.controller.dispose();
});

test("disposed project state rejects later bridge requests", async () => {
  const harness = createHarness();
  harness.controller.dispose();
  await assert.rejects(harness.controller.handleRequest("alpha", {
    method: "workbench/thread-state/project/refresh",
    projectId: "alpha",
  }), /disposed/u);
});

test("bridge mutations return metadata and publish the resulting changed tree", async () => {
  const harness = createHarness();
  const updates: WorkbenchProjectStateUpdate[] = [];
  const stop = harness.controller.observe("alpha", (update) => updates.push(update));
  await waitFor(() => updates.length === 1, "Initial snapshot was not published.");
  harness.setSnapshotReader(async () => createSnapshot("alpha", "created.md"));
  const result = await harness.controller.handleRequest("alpha", {
    method: "workbench/thread-state/project/entry/create",
    name: "created.md",
    parentPath: "",
    projectId: "alpha",
    type: "file",
  });
  assert.deepEqual(result, { path: "created.md", type: "file" });
  await waitFor(() => updates.length === 2, "Mutation snapshot was not published.");
  assert.equal(harness.snapshotReads, 2);
  stop();
  harness.controller.dispose();
});

test("untracked file deletion requires explicit confirmation", async () => {
  const harness = createHarness();
  harness.setTracked(false);
  const result = await harness.controller.handleRequest("alpha", {
    method: "workbench/thread-state/project/file/delete",
    path: "notes.md",
    projectId: "alpha",
  });
  assert.deepEqual(harness.deletedPaths, []);
  assert.deepEqual(result, {
    confirmationRequired: true,
    path: "notes.md",
    projectId: "alpha",
    tracked: false,
  });
  harness.controller.dispose();
});

test("confirmed untracked file deletion proceeds", async () => {
  const harness = createHarness();
  harness.setTracked(false);
  const result = await harness.controller.handleRequest("alpha", {
    confirmUntracked: true,
    method: "workbench/thread-state/project/file/delete",
    path: "notes.md",
    projectId: "alpha",
  });
  assert.deepEqual(harness.deletedPaths, ["notes.md"]);
  assert.deepEqual(result, { path: "notes.md", tracked: false });
  harness.controller.dispose();
});

test("the dormant HTTP compatibility adapter delegates to the same mutation owner", async () => {
  const harness = createHarness();
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
  assert.equal(harness.snapshotReads, 1);
  assert.equal(harness.watchers.length, 0);
  harness.controller.dispose();
});

test("unobserved snapshots use bounded LRU storage without watcher ownership", async () => {
  const harness = createHarness({ maxProjectSnapshots: 1 });
  await harness.readTree("alpha");
  await harness.readTree("beta");
  await harness.readTree("alpha");
  assert.equal(harness.snapshotReads, 3);
  assert.equal(harness.watchers.length, 0);
  harness.controller.dispose();
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
