/*
 * Exports:
 * - No production exports; Node tests cover structured project catalog caching, coalescing, watcher invalidation, soft TTL refresh, CWD resolution, retry, and disposal. Keywords: project, catalog, cache, watcher, cwd, lifecycle, test.
 */
import assert from "node:assert/strict";
import type http from "node:http";
import { test } from "node:test";

import type { ResolvedProject } from "../lib/project";
import type { WorkbenchProjectOption } from "../lib/types";
import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";

class FakeWatcher {
  closed = false;
  private errorListener = () => undefined;

  constructor(
    readonly rootPath: string,
    private readonly changeListener: (eventType: string, filename: string | Buffer | null) => void,
    readonly recursive: boolean,
  ) {}

  close() { this.closed = true; }
  emitChange(eventType: string, filename: string) { this.changeListener(eventType, filename); }
  emitError() { this.errorListener(); }
  on(_event: "error", listener: () => void) {
    this.errorListener = listener;
    return this;
  }
}

function deferred<TValue>() {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function createProject(id: string): WorkbenchProjectOption {
  const rootPath = `C:/projects/${id}`;
  return {
    id,
    kind: "git",
    lastCommitTimeMs: null,
    name: id,
    relativePath: id,
    rootPath,
    roots: [{ id, isPrimary: true, name: id, relativePath: id, rootPath }],
  };
}

function resolveFromCatalog(
  projects: readonly WorkbenchProjectOption[],
  cwd: string | null | undefined,
  { endpointName = "Agent endpoint" }: { endpointName?: string } = {},
): Promise<AgentEndpointProjectResolution> {
  const project = projects.find((candidate) => cwd?.replace(/\\/gu, "/").startsWith(candidate.rootPath));
  if (!project || !cwd) throw new Error(`${endpointName} cwd is unknown.`);
  const resolvedProject: ResolvedProject = {
    id: project.id,
    kind: project.kind,
    root: project.rootPath,
    rootPath: project.rootPath,
    roots: project.roots.map((root) => ({ id: root.id, name: root.name, root: root.rootPath, rootPath: root.rootPath })),
  };
  return Promise.resolve({ cwd, project: resolvedProject, root: resolvedProject.roots[0] });
}

function resolveProjectByIdFromCatalog(
  projects: readonly WorkbenchProjectOption[],
  projectId?: string | null,
): Promise<ResolvedProject> {
  const project = projects.find((candidate) => candidate.id === (projectId ?? projects[0]?.id));
  if (!project) throw new Error("Unknown project.");
  return Promise.resolve({
    id: project.id,
    kind: project.kind,
    root: project.rootPath,
    rootPath: project.rootPath,
    roots: project.roots.map((root) => ({ id: root.id, name: root.name, root: root.rootPath, rootPath: root.rootPath })),
  });
}

function createResponse() {
  let body = "";
  let cacheState = "";
  const response = {
    end(value: string) { body = value; },
    writeHead(_statusCode: number, headers: Record<string, string | number>) {
      cacheState = String(headers["X-Workbench-Snapshot-Cache"] ?? "");
    },
  } as unknown as http.ServerResponse;
  return { response, get body() { return body; }, get cacheState() { return cacheState; } };
}

function createHarness() {
  let discoveryReads = 0;
  let now = 1_000;
  let projects = [createProject("alpha")];
  let readProjects = async () => projects;
  let resolveProjects = resolveFromCatalog;
  const loggedErrors: string[] = [];
  const watchers: FakeWatcher[] = [];
  const controller = new WorkbenchProjectCatalogController({
    cacheTtlMs: 100,
    createWatcher(rootPath, listener, recursive) {
      const watcher = new FakeWatcher(rootPath, listener, recursive);
      watchers.push(watcher);
      return watcher;
    },
    discoverProjects: async () => {
      discoveryReads += 1;
      return await readProjects();
    },
    logError: (message) => { loggedErrors.push(message); },
    now: () => now,
    projectsRootPath: "C:/projects",
    resolveProjectByIdFromCatalog,
    resolveProjectFromCatalog: async (catalog, cwd, options) => await resolveProjects(catalog, cwd, options),
  });
  return {
    controller,
    get discoveryReads() { return discoveryReads; },
    loggedErrors,
    setNow(value: number) { now = value; },
    setProjects(value: WorkbenchProjectOption[]) { projects = value; },
    setReader(value: typeof readProjects) { readProjects = value; },
    setResolver(value: typeof resolveProjects) { resolveProjects = value; },
    watchers,
  };
}

test("reuses one structured catalog for repeated CWD resolution", async () => {
  const harness = createHarness();
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src")).project.id, "alpha");
  assert.deepEqual(harness.controller.getCurrentSnapshot(), { data: [createProject("alpha")], rootPath: "C:/projects" });
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/test")).project.id, "alpha");
  assert.equal(harness.discoveryReads, 1);
  assert.equal(harness.watchers[0]?.recursive, false);
});

test("coalesces concurrent initial catalog discovery", async () => {
  const harness = createHarness();
  const gate = deferred<WorkbenchProjectOption[]>();
  harness.setReader(async () => await gate.promise);
  const first = harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  const second = harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/test");
  gate.resolve([createProject("alpha")]);
  await Promise.all([first, second]);
  assert.equal(harness.discoveryReads, 1);
});

test("ensureLoaded coalesces with initial resolution and makes the snapshot synchronously available", async () => {
  const harness = createHarness();
  const gate = deferred<WorkbenchProjectOption[]>();
  harness.setReader(async () => await gate.promise);

  const loading = harness.controller.ensureLoaded();
  const resolution = harness.controller.resolveProjectById("alpha");
  assert.equal(harness.discoveryReads, 1);
  gate.resolve([createProject("alpha")]);

  assert.equal((await resolution).id, "alpha");
  await loading;
  await harness.controller.ensureLoaded();
  assert.deepEqual(harness.controller.getCurrentSnapshot(), { data: [createProject("alpha")], rootPath: "C:/projects" });
  assert.equal(harness.discoveryReads, 1);
});

test("watcher invalidation serves a known CWD while one background refresh runs", async () => {
  const harness = createHarness();
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  harness.watchers[0]?.emitChange("change", "workspace.code-workspace");
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  assert.equal(harness.discoveryReads, 2);
});

test("invalidation during a refresh does not loop the same caller", async () => {
  const harness = createHarness();
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  const gate = deferred<WorkbenchProjectOption[]>();
  harness.setReader(async () => await gate.promise);
  harness.watchers[0]?.emitChange("change", "workspace.code-workspace");
  const resolution = harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  await Promise.resolve();
  harness.controller.invalidate();
  harness.setReader(async () => [createProject("alpha")]);
  gate.resolve([createProject("alpha")]);
  assert.equal((await resolution).project.id, "alpha");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.discoveryReads, 2);
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src")).project.id, "alpha");
  assert.equal(harness.discoveryReads, 3);
});

test("soft TTL expiry returns a known CWD while one background refresh runs", async () => {
  const harness = createHarness();
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  harness.setNow(2_000);
  const gate = deferred<WorkbenchProjectOption[]>();
  harness.setReader(async () => await gate.promise);
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src")).project.id, "alpha");
  assert.equal(harness.discoveryReads, 2);
  gate.resolve([createProject("alpha")]);
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  assert.equal(harness.discoveryReads, 2);
});

test("soft TTL expiry serves stale HTTP data while one background refresh runs", async () => {
  const harness = createHarness();
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  harness.setNow(2_000);
  const gate = deferred<WorkbenchProjectOption[]>();
  harness.setReader(async () => await gate.promise);
  const target = createResponse();

  await harness.controller.handleHttpRequest({} as http.IncomingMessage, target.response);

  assert.equal(target.cacheState, "stale");
  assert.match(target.body, /alpha/u);
  assert.equal(harness.discoveryReads, 2);
  gate.resolve([createProject("alpha")]);
});

test("failed background refresh logs once and preserves the last-good catalog", async () => {
  const harness = createHarness();
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  harness.setNow(2_000);
  harness.setReader(async () => { throw new Error("refresh exploded at C:/private/project"); });

  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src")).project.id, "alpha");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(harness.loggedErrors.length, 1);
  assert.match(harness.loggedErrors[0] ?? "", /background refresh failed/u);
  assert.doesNotMatch(harness.loggedErrors[0] ?? "", /C:\/private/u);
});

test("an unknown CWD forces one refresh and retry", async () => {
  const harness = createHarness();
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  harness.setNow(2_000);
  harness.setProjects([createProject("alpha"), createProject("beta")]);
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/beta/src")).project.id, "beta");
  assert.equal(harness.discoveryReads, 2);
});

test("an unknown CWD retries the exact refresh generation started by its read", async () => {
  const harness = createHarness();
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  harness.setNow(2_000);
  harness.setProjects([createProject("alpha"), createProject("beta")]);
  harness.setResolver(async (projects, cwd, options) => {
    if (projects.length === 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throw new Error("Browse cwd is unknown.");
    }
    return await resolveFromCatalog(projects, cwd, options);
  });

  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/beta/src")).project.id, "beta");
  assert.equal(harness.discoveryReads, 2);
});

test("a known project ID uses stale catalog while its refresh runs", async () => {
  const harness = createHarness();
  assert.equal((await harness.controller.resolveProjectById("alpha")).id, "alpha");
  harness.setNow(2_000);
  const gate = deferred<WorkbenchProjectOption[]>();
  harness.setReader(async () => await gate.promise);

  assert.equal((await harness.controller.resolveProjectById("alpha")).id, "alpha");
  assert.equal(harness.discoveryReads, 2);
  gate.resolve([createProject("alpha")]);
});

test("an unknown project ID forces one refresh and retry", async () => {
  const harness = createHarness();
  assert.equal((await harness.controller.resolveProjectById("alpha")).id, "alpha");
  harness.setProjects([createProject("alpha"), createProject("beta")]);

  assert.equal((await harness.controller.resolveProjectById("beta")).id, "beta");
  assert.equal(harness.discoveryReads, 2);
});

test("disposal fences publication from an in-flight generation", async () => {
  const harness = createHarness();
  const gate = deferred<WorkbenchProjectOption[]>();
  harness.setReader(async () => await gate.promise);
  const pending = harness.controller.resolveProjectById("alpha");
  await Promise.resolve();
  harness.controller.dispose();
  gate.resolve([createProject("alpha")]);

  assert.equal((await pending).id, "alpha");
  await assert.rejects(harness.controller.resolveProjectById("alpha"), /disposed/u);
});

test("disposal closes the watcher and rejects later work", async () => {
  const harness = createHarness();
  harness.controller.dispose();
  assert.equal(harness.watchers[0]?.closed, true);
  await assert.rejects(harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src"), /disposed/u);
});
