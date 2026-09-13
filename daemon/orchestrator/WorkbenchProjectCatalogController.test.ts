/*
 * Exports:
 * - No production exports; Node tests cover project icon assets, catalog caching, coalescing, watcher invalidation, soft TTL refresh, CWD resolution, retry, and disposal.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ResolvedProject } from "../lib/project";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<TValue>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function createProject(id: string, rootPath = `C:/projects/${id}`): WorkbenchProjectOption {
  return {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse(id),
    kind: "git",
    lastCommitTimeMs: null,
    name: id,
    relativePath: id,
    rootPath,
    roots: [{ id, isPrimary: true, name: id, relativePath: id, rootPath }],
  };
}

test("replacement catalog serves its retained snapshot while discovery is pending", async () => {
  const discovery = deferred<WorkbenchProjectOption[]>();
  const initialSnapshot = { data: [createProject("retained")], rootPath: "C:/projects" };
  const options = {
    initialSnapshot,
    now: () => 1,
    discoverProjects: () => discovery.promise,
    createWatcher: (root: string, listener: (event: string, filename: string | Buffer | null) => void, recursive: boolean) => (
      new FakeWatcher(root, listener, recursive)
    ),
  };
  const controller = new WorkbenchProjectCatalogController(options);
  try {
    assert.deepEqual(controller.getCurrentSnapshot(), initialSnapshot);
    await controller.ensureLoaded();
    assert.deepEqual(await controller.readCatalog(), initialSnapshot);
  } finally {
    controller.dispose();
    discovery.resolve([createProject("fresh")]);
  }
});

function createIconResponse() {
  let body = new Uint8Array();
  let headers: Record<string, string | number> = {};
  let statusCode = 200;
  const response = {
    end(value: string | Uint8Array = "") {
      body = typeof value === "string" ? Buffer.from(value) : new Uint8Array(value);
    },
    writeHead(nextStatusCode: number, nextHeaders: Record<string, string | number>) {
      statusCode = nextStatusCode;
      headers = nextHeaders;
    },
  } as unknown as http.ServerResponse;
  return {
    response,
    get body() { return body; },
    get headers() { return headers; },
    get statusCode() { return statusCode; },
  };
}

function iconRequest(projectId: string) {
  return {
    headers: {},
    method: "GET",
    url: `/orchestrator/project-icons/${encodeURIComponent(projectId)}`,
  } as http.IncomingMessage;
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
  let resolutionReads = 0;
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
    resolveProjectFromCatalog: async (catalog, cwd, options) => {
      resolutionReads += 1;
      return await resolveProjects(catalog, cwd, options);
    },
  });
  return {
    controller,
    get discoveryReads() { return discoveryReads; },
    get resolutionReads() { return resolutionReads; },
    loggedErrors,
    setNow(value: number) { now = value; },
    setProjects(value: WorkbenchProjectOption[]) { projects = value; },
    setReader(value: typeof readProjects) { readProjects = value; },
    setResolver(value: typeof resolveProjects) { resolveProjects = value; },
    watchers,
  };
}

test("durable CWD resolutions share bursts and survive unchanged catalog refreshes", async (context) => {
  const harness = createHarness();
  context.after(() => harness.controller.dispose());
  const cwd = "C:/projects/alpha/src";
  const gate = deferred<AgentEndpointProjectResolution>();
  harness.setResolver(() => gate.promise);
  const burst = Array.from({ length: 276 }, () => harness.controller.resolveAgentEndpointProjectFromCwd(cwd));
  gate.resolve(await resolveFromCatalog([createProject("alpha")], cwd));
  assert.ok((await Promise.all(burst)).every(result => result.project.id === "alpha"));
  await harness.controller.resolveAgentEndpointProjectFromCwd(cwd);
  assert.equal(harness.resolutionReads, 1, "one validation serves concurrent and sequential identical requests");

  harness.setResolver(resolveFromCatalog);
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/test");
  await harness.controller.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Browse" });
  assert.equal(harness.resolutionReads, 3, "different CWDs and endpoint labels remain independent");

  harness.setNow(2_000);
  harness.setProjects([{ ...createProject("alpha"), lastCommitTimeMs: 123, icon: { rootId: "alpha", path: "favicon.png" } }]);
  await harness.controller.resolveAgentEndpointProjectFromCwd(cwd);
  await assert.rejects(harness.controller.resolveProjectById("missing"), /Unknown project/u);
  assert.ok(harness.discoveryReads > 1, "a resolution cache hit still starts due discovery");
  await harness.controller.resolveAgentEndpointProjectFromCwd(cwd);
  assert.equal(harness.resolutionReads, 3, "activity and icon refreshes do not discard ownership");

  harness.setProjects([createProject("beta", "C:/projects/alpha")]);
  await harness.controller.resolveProjectById("beta");
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd(cwd)).project.id, "beta");
  assert.equal(harness.resolutionReads, 4, "changed ownership retires old resolutions");
  harness.controller.invalidate();
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd(cwd)).project.id, "beta");
  assert.equal(harness.resolutionReads, 5, "explicit invalidation forces validation");
});

test("failed CWD resolutions share retry work without retaining failures", async (context) => {
  const harness = createHarness();
  context.after(() => harness.controller.dispose());
  await harness.controller.ensureLoaded();
  harness.setResolver(async (_projects, _cwd, { endpointName = "Agent endpoint" } = {}) => {
    throw new Error(`${endpointName} rejected`);
  });
  const cwd = "C:/projects/alpha";
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => (
    harness.controller.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Git arc" })
  )));
  assert.ok(results.every(result => result.status === "rejected" && /Git arc rejected/u.test(String(result.reason))));
  assert.equal(harness.resolutionReads, 2, "one shared initial attempt and refresh retry");
  await assert.rejects(harness.controller.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Browse" }), /Browse rejected/u);
  assert.equal(harness.resolutionReads, 4);
  harness.setResolver(resolveFromCatalog);
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Git arc" })).project.id, "alpha");
  assert.equal(harness.resolutionReads, 5, "failure does not poison later requests");
});

test("catalog root changes invalidate cached ownership even when project identity stays the same", async (context) => {
  const harness = createHarness();
  context.after(() => harness.controller.dispose());
  const cwd = "C:/projects/alpha/src";
  const original = await harness.controller.resolveAgentEndpointProjectFromCwd(cwd);
  const changed = createProject("alpha", "C:/projects");
  changed.roots[0] = { ...changed.roots[0], id: "parent", name: "parent workspace" };
  harness.setProjects([changed]);
  await assert.rejects(harness.controller.resolveProjectById("missing"), /Unknown project/u);
  const resolved = await harness.controller.resolveAgentEndpointProjectFromCwd(cwd);
  assert.notDeepEqual(resolved.root, original.root);
  assert.equal(resolved.project.id, original.project.id);
  assert.equal(resolved.root.rootPath, changed.roots[0].rootPath);
  assert.equal(resolved.root.id, changed.roots[0].id);
  assert.equal(resolved.root.name, changed.roots[0].name);
});

test("a retired failed resolution cannot remove newer in-flight work", async (context) => {
  const harness = createHarness();
  context.after(() => harness.controller.dispose());
  const cwd = "C:/projects/alpha";
  const entered = deferred<void>();
  const old = deferred<AgentEndpointProjectResolution>();
  harness.setResolver(() => {
    entered.resolve();
    return old.promise;
  });
  const first = harness.controller.resolveAgentEndpointProjectFromCwd(cwd);
  const rejected = assert.rejects(first, /old failure/u);
  await entered.promise;
  harness.controller.invalidate();
  const newer = deferred<AgentEndpointProjectResolution>();
  const newerEntered = deferred<void>();
  harness.setResolver(() => {
    newerEntered.resolve();
    return newer.promise;
  });
  const second = harness.controller.resolveAgentEndpointProjectFromCwd(cwd);
  await newerEntered.promise;
  old.reject(new Error("old failure"));
  await rejected;
  const joined = harness.controller.resolveAgentEndpointProjectFromCwd(cwd);
  newer.resolve(await resolveFromCatalog([createProject("alpha")], cwd));
  assert.deepEqual(await second, await joined);
  assert.equal(harness.resolutionReads, 2, "old failure leaves the newer request joinable");
});

test("retired CWD work cannot replace newer mappings or survive disposal", async (context) => {
  const harness = createHarness();
  context.after(() => harness.controller.dispose());
  await harness.controller.ensureLoaded();
  const cwd = "C:/projects/alpha";
  const entered = deferred<void>();
  const old = deferred<AgentEndpointProjectResolution>();
  harness.setResolver(() => {
    entered.resolve();
    return old.promise;
  });
  const pending = harness.controller.resolveAgentEndpointProjectFromCwd(cwd);
  await entered.promise;
  harness.controller.invalidate();
  harness.setProjects([createProject("beta", cwd)]);
  await harness.controller.resolveProjectById("beta");
  harness.setResolver(resolveFromCatalog);
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd(cwd)).project.id, "beta");
  old.resolve(await resolveFromCatalog([createProject("alpha")], cwd));
  assert.equal((await pending).project.id, "alpha");
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd(cwd)).project.id, "beta");
  const readsAfterRetirement = harness.resolutionReads;

  const disposing = deferred<AgentEndpointProjectResolution>();
  const disposingEntered = deferred<void>();
  harness.setResolver(() => {
    disposingEntered.resolve();
    return disposing.promise;
  });
  const last = harness.controller.resolveAgentEndpointProjectFromCwd(`${cwd}/other`);
  await disposingEntered.promise;
  const rejected = assert.rejects(last, /disposed/u);
  harness.controller.dispose();
  disposing.resolve(await resolveFromCatalog([createProject("beta", cwd)], `${cwd}/other`));
  await rejected;
  assert.equal(readsAfterRetirement, 2, "old completion cannot evict the newer cached result");
});

test("serves catalog-selected PNG and ICO assets with bounded content types", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-project-icon-asset-"));
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const icoBytes = Buffer.from([0x00, 0x00, 0x01, 0x00]);
  await fs.writeFile(path.join(root, "favicon.png"), pngBytes);
  await fs.writeFile(path.join(root, "favicon.ico"), icoBytes);
  const pngProject = {
    ...createProject("team/png", root),
    icon: { path: "favicon.png", rootId: "team/png" },
  };
  const icoProject = {
    ...createProject("team/ico", root),
    icon: { path: "favicon.ico", rootId: "team/ico" },
  };
  const controller = new WorkbenchProjectCatalogController({
    createWatcher: () => new FakeWatcher(root, () => undefined, false),
    discoverProjects: async () => [pngProject, icoProject],
    projectsRootPath: root,
  });
  context.after(async () => {
    controller.dispose();
    await fs.rm(root, { force: true, recursive: true });
  });

  const png = createIconResponse();
  await controller.handleIconHttpRequest(iconRequest(pngProject.id), png.response);
  assert.equal(png.statusCode, 200);
  assert.equal(png.headers["Content-Type"], "image/png");
  assert.equal(png.headers["X-Content-Type-Options"], "nosniff");
  assert.deepEqual([...png.body], [...pngBytes]);

  const ico = createIconResponse();
  await controller.handleIconHttpRequest(iconRequest(icoProject.id), ico.response);
  assert.equal(ico.statusCode, 200);
  assert.equal(ico.headers["Content-Type"], "image/x-icon");
  assert.deepEqual([...ico.body], [...icoBytes]);
});

test("rejects catalog icon descriptors that escape their project root", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-project-icon-escape-"));
  const projectRoot = path.join(temporaryRoot, "project");
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(temporaryRoot, "outside.png"), "outside", "utf8");
  const project = {
    ...createProject("escape", projectRoot),
    icon: { path: "../outside.png", rootId: "escape" },
  };
  const controller = new WorkbenchProjectCatalogController({
    createWatcher: () => new FakeWatcher(temporaryRoot, () => undefined, false),
    discoverProjects: async () => [project],
    projectsRootPath: temporaryRoot,
  });
  context.after(async () => {
    controller.dispose();
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  });

  const output = createIconResponse();
  await controller.handleIconHttpRequest(iconRequest(project.id), output.response);
  assert.equal(output.statusCode, 404);
  assert.deepEqual(JSON.parse(Buffer.from(output.body).toString("utf8")), { error: "Project icon not found." });
});

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

test("coalesced failed background refresh logs once and preserves the last-good catalog", async () => {
  const harness = createHarness();
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  harness.setNow(2_000);
  const gate = deferred<WorkbenchProjectOption[]>();
  harness.setReader(async () => await gate.promise);

  const first = harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  const second = harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/test");
  assert.deepEqual(
    (await Promise.all([first, second])).map((resolution) => resolution.project.id),
    ["alpha", "alpha"],
  );
  assert.equal(harness.discoveryReads, 2);

  gate.reject(new Error("refresh exploded at C:/private/project"));
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
