/*
 * Exports:
 * - No production exports; Node tests cover structured project catalog caching, coalescing, watcher invalidation, soft TTL refresh, CWD resolution, retry, and disposal. Keywords: project, catalog, cache, watcher, cwd, lifecycle, test.
 */
import assert from "node:assert/strict";
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

function createHarness() {
  let discoveryReads = 0;
  let now = 1_000;
  let projects = [createProject("alpha")];
  let readProjects = async () => projects;
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
    now: () => now,
    projectsRootPath: "C:/projects",
    resolveProjectFromCatalog: resolveFromCatalog,
  });
  return {
    controller,
    get discoveryReads() { return discoveryReads; },
    setNow(value: number) { now = value; },
    setProjects(value: WorkbenchProjectOption[]) { projects = value; },
    setReader(value: typeof readProjects) { readProjects = value; },
    watchers,
  };
}

test("reuses one structured catalog for repeated CWD resolution", async () => {
  const harness = createHarness();
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src")).project.id, "alpha");
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

test("hard watcher invalidation refreshes before resolving", async () => {
  const harness = createHarness();
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  harness.watchers[0]?.emitChange("change", "workspace.code-workspace");
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  assert.equal(harness.discoveryReads, 2);
});

test("invalidation during a refresh discards that generation and refreshes again", async () => {
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

test("an unknown CWD forces one refresh and retry", async () => {
  const harness = createHarness();
  await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src");
  harness.setProjects([createProject("alpha"), createProject("beta")]);
  assert.equal((await harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/beta/src")).project.id, "beta");
  assert.equal(harness.discoveryReads, 2);
});

test("disposal closes the watcher and rejects later work", async () => {
  const harness = createHarness();
  harness.controller.dispose();
  assert.equal(harness.watchers[0]?.closed, true);
  await assert.rejects(harness.controller.resolveAgentEndpointProjectFromCwd("C:/projects/alpha/src"), /disposed/u);
});
