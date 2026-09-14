/*
 * Exports:
 * - No production exports; Node tests protect pushed project snapshots, revision isolation, catalog-only selection, and bridge mutations.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProjectSnapshot, WorkbenchProjectOption } from "workbench-shared/types";
import WorkbenchProjectClient, { type WorkbenchProjectTransport } from "./WorkbenchProjectClient";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

function createProject(projectId: string): WorkbenchProjectOption {
  return {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse(projectId),
    kind: "git",
    lastCommitTimeMs: null,
    name: projectId,
    relativePath: projectId,
    rootPath: `C:/projects/${projectId}`,
    roots: [{ id: projectId, isPrimary: true, name: projectId, relativePath: projectId, rootPath: `C:/projects/${projectId}` }],
  };
}

function createSnapshot(projectId: string, fileName = "README.md"): ProjectSnapshot {
  return {
    changes: {},
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse(projectId),
    root: projectId,
    rootPath: `C:/projects/${projectId}`,
    roots: createProject(projectId).roots,
    tree: [{ name: fileName, path: fileName, type: "file" }],
    workbenchStorageRootPath: "C:/projects/workbench",
  };
}

function installProjectsFetch(projects: WorkbenchProjectOption[]) {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ data: projects, rootPath: "C:/projects" }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
  return {
    requests,
    restore() { globalThis.fetch = originalFetch; },
  };
}

function installProjectsPayloadFetch(payload: unknown) {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
  return {
    requests,
    restore() { globalThis.fetch = originalFetch; },
  };
}

function createTransport() {
  const calls: string[] = [];
  const transport: WorkbenchProjectTransport = {
    async createEntry(projectId, parentPath, name, type) {
      calls.push(`create:${projectId}:${parentPath}:${name}:${type}`);
      return { path: parentPath ? `${parentPath}/${name}` : name, type };
    },
    async deleteFile(projectId, filePath, options) {
      calls.push(`delete:${projectId}:${filePath}:${options.confirmUntracked === true}`);
      return { path: filePath, tracked: true };
    },
    async readCatalog() {
      return await (await fetch("/api/projects")).json() as import("workbench-shared/types").WorkbenchProjectsPayload;
    },
    async refresh(projectId) {
      calls.push(`refresh:${projectId}`);
    },
  };
  return { calls, transport };
}

test("project selection loads only the catalog and waits for a pushed tree snapshot", async () => {
  const fetchHarness = installProjectsFetch([createProject("alpha")]);
  try {
    const { transport } = createTransport();
    const client = WorkbenchProjectClient({ transport });
    assert.equal(await client.selectProjectStrict("alpha"), true);
    assert.deepEqual(fetchHarness.requests, ["/api/projects"]);
    assert.equal(client.getSnapshot().currentProjectId, "alpha");
    assert.equal(client.getSnapshot().isLoading, true);
    assert.deepEqual(client.getSnapshot().tree, []);

    client.accept({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"), revision: 0, snapshot: createSnapshot("alpha"), updateKind: "project" });
    assert.equal(client.getSnapshot().isLoading, false);
    assert.equal(client.getSnapshot().tree[0]?.name, "README.md");
    client.dispose();
  } finally {
    fetchHarness.restore();
  }
});

test("project catalog conformance is display-only and never becomes a transport mutation", async (context) => {
  const fetchHarness = installProjectsPayloadFetch({
    data: [createProject("alpha"), { id: 42 }],
    rootPath: "C:/projects",
  });
  const diagnostics: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values) => { diagnostics.push(values.map(String).join(" ")); };
  context.after(() => {
    console.error = originalConsoleError;
    fetchHarness.restore();
  });

  const { calls, transport } = createTransport();
  const client = WorkbenchProjectClient({ transport });
  assert.equal(await client.selectProjectStrict("alpha"), true);
  assert.equal(client.getSnapshot().projects.length, 1);
  assert.equal(client.getSnapshot().projects[0]?.id, "alpha");
  assert.deepEqual(calls, []);
  assert.deepEqual(fetchHarness.requests, ["/api/projects"]);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /Repaired Workbench project catalog response/u);
  client.dispose();
});

test("route identity accepts a pushed tree before catalog enrichment and can roll back", () => {
  const { transport } = createTransport();
  const client = WorkbenchProjectClient({ transport });
  const rollback = client.beginProjectSelection("alpha");
  assert.equal(client.getSnapshot().currentProjectId, "alpha");
  assert.equal(client.getSnapshot().isLoading, true);

  client.accept({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"), revision: 0, snapshot: createSnapshot("alpha", "instant.ts"), updateKind: "project" });
  client.installCatalog({ data: [createProject("alpha")], rootPath: "C:/projects" });
  assert.equal(client.getSnapshot().tree[0]?.name, "instant.ts");
  assert.equal(client.getSnapshot().isLoading, false);
  assert.equal(client.getSnapshot().projects[0]?.id, "alpha");

  const rollbackUnknown = client.beginProjectSelection("missing");
  assert.equal(client.getSnapshot().currentProjectId, "missing");
  rollbackUnknown?.();
  assert.equal(client.getSnapshot().currentProjectId, "alpha");
  assert.equal(client.getSnapshot().tree[0]?.name, "instant.ts");
  rollback?.();
  client.dispose();
});

test("project updates reject stale and foreign revisions", async () => {
  const fetchHarness = installProjectsFetch([createProject("alpha"), createProject("beta")]);
  try {
    const { transport } = createTransport();
    const client = WorkbenchProjectClient({ transport });
    await client.selectProjectStrict("alpha");
    client.accept({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"), revision: 2, snapshot: createSnapshot("alpha", "new.ts"), updateKind: "project" });
    client.accept({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"), revision: 1, snapshot: createSnapshot("alpha", "stale.ts"), updateKind: "project" });
    client.accept({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"), revision: 3, snapshot: createSnapshot("beta", "foreign.ts"), updateKind: "project" });
    assert.equal(client.getSnapshot().tree[0]?.name, "new.ts");
    client.dispose();
  } finally {
    fetchHarness.restore();
  }
});

test("entering home retains the catalog and clears every project-owned explorer field", async () => {
  const fetchHarness = installProjectsFetch([createProject("alpha"), createProject("beta")]);
  try {
    const { transport } = createTransport();
    const client = WorkbenchProjectClient({ transport });
    await client.selectProjectStrict("alpha");
    client.accept({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"), revision: 2, snapshot: createSnapshot("alpha", "owned.ts"), updateKind: "project" });

    client.enterNoProject();

    const home = client.getSnapshot();
    assert.equal(home.currentProjectId, "");
    assert.deepEqual(home.projects.map(({ id }) => id), ["alpha", "beta"]);
    assert.deepEqual(home.tree, []);
    assert.deepEqual(home.roots, []);
    assert.deepEqual(home.changes, {});
    assert.deepEqual(home.expandedDirectories, []);
    assert.equal(home.isLoading, false);
    client.accept({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"), revision: 3, snapshot: createSnapshot("alpha", "late.ts"), updateKind: "project" });
    assert.equal(client.getSnapshot().currentProjectId, "");
    assert.deepEqual(client.getSnapshot().tree, []);
    client.dispose();
  } finally {
    fetchHarness.restore();
  }
});

test("observation reset accepts a restarted revision without clearing the best-known tree", async () => {
  const fetchHarness = installProjectsFetch([createProject("alpha")]);
  try {
    const { transport } = createTransport();
    const client = WorkbenchProjectClient({ transport });
    await client.selectProjectStrict("alpha");
    client.accept({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"), revision: 5, snapshot: createSnapshot("alpha", "best-known.ts"), updateKind: "project" });
    client.resetObservation();
    assert.equal(client.getSnapshot().tree[0]?.name, "best-known.ts");
    client.accept({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"), revision: 0, snapshot: createSnapshot("alpha", "after-reload.ts"), updateKind: "project" });
    assert.equal(client.getSnapshot().tree[0]?.name, "after-reload.ts");
    client.dispose();
  } finally {
    fetchHarness.restore();
  }
});

test("refresh, create, and delete use the injected bridge transport", async () => {
  const fetchHarness = installProjectsFetch([createProject("alpha")]);
  try {
    const { calls, transport } = createTransport();
    const client = WorkbenchProjectClient({ transport });
    await client.selectProjectStrict("alpha");
    await client.refreshProject();
    assert.equal(await client.createEntry("src", "new.ts", "file"), "src/new.ts");
    assert.deepEqual(await client.deleteFile("src/old.ts", { confirmUntracked: true }), { path: "src/old.ts", tracked: true });
    assert.deepEqual(calls, [
      "refresh:alpha",
      "create:alpha:src:new.ts:file",
      "delete:alpha:src/old.ts:true",
    ]);
    assert.deepEqual(fetchHarness.requests, ["/api/projects"]);
    client.dispose();
  } finally {
    fetchHarness.restore();
  }
});
