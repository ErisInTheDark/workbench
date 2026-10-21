/* No exports. Protect shared partial search, per-daemon search lanes, filters, source recovery and cancelled-query fences. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkspaceDaemonFact } from "workbench-shared/workbench/workspace/workspace-observation";
import type { WorkbenchSearchResponse, WorkbenchSearchResult } from "workbench-shared/workbench/search/workbench-search";
import WorkbenchWorkspaceSearch from "./WorkbenchWorkspaceSearch";

function fixture(canProject: () => boolean = () => true) {
  let databaseOpen = true;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of [...listeners]) listener(); };
  const makeSource = () => {
    const id = DaemonIdSchema.parse(randomUUID());
    let fact: WorkspaceDaemonFact = { daemonId: id, hostname: id, connection: "current", generation: 1, failure: null };
    let leases = 0;
    const requests: Array<{
      params: object; signal?: AbortSignal;
      resolve(value: WorkbenchSearchResponse): void; reject(error: Error): void;
    }> = [];
    return {
      id, requests, get leases() { return leases; },
      get available() { return fact.connection === "current"; },
      getSnapshot: () => fact,
      retain: () => { leases++; return () => { leases--; }; },
      request: <Result>(_method: string, params: object = {}, _fields: object = {}, options: { signal?: AbortSignal } = {}) =>
        new Promise<Result>((resolve, reject) => requests.push({
          params, signal: options.signal, resolve: value => resolve(value as Result), reject,
        })),
      change: (patch: Partial<WorkspaceDaemonFact>) => { fact = { ...fact, ...patch }; changed(); },
    };
  };
  const a = makeSource();
  const b = makeSource();
  const logicalId = LogicalProjectIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse("project");
  const presentation: PresentationSnapshot = {
    revision: 0, daemons: [], projects: [{ id: logicalId, matchKey: "shared", label: "Project" }],
    locations: [a, b].map(source => ({ target: { daemonId: source.id, projectId },
      logicalProjectId: logicalId, identityKey: "shared", name: "Project", rootPath: "/project" })),
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const warnings: string[] = [];
  const owner = new WorkbenchWorkspaceSearch({
    sources: { attached: a, all: () => [a, b], subscribe: listener => {
      listeners.add(listener); return () => { listeners.delete(listener); };
    } },
    presentation: { read: () => {
      if (!databaseOpen) throw new Error("Presentation database is not ready.");
      return presentation;
    }, subscribe: listener => {
      const changed = () => listener(presentation.revision);
      listeners.add(changed); return () => { listeners.delete(changed); };
    } },
    warn: message => warnings.push(message),
    canProject,
  });
  const notifications = new Set<() => void>();
  const observe = (query = "find") => owner.observe({ projectId: logicalId, query },
    () => { for (const notify of [...notifications]) notify(); });
  const wait = (predicate: () => boolean) => new Promise<void>(resolve => {
    const notify = () => { if (predicate()) { notifications.delete(notify); resolve(); } };
    notifications.add(notify); notify();
  });
  const hit = (id: string): Extract<WorkbenchSearchResult, { kind: "thread" }> => ({
    kind: "thread", id, projectId, threadId: id, harnessId: "codex", title: id, detail: "",
  });
  return { owner, a, b, changed, observe, wait, hit, warnings, presentation,
    setDatabaseOpen(value: boolean) { databaseOpen = value; } };
}

test("late search work cannot read detached presentation and resumes with its result", async context => {
  let canProject = true;
  const f = fixture(() => canProject); context.after(() => f.owner.dispose());
  const view = f.observe();
  canProject = false;
  f.setDatabaseOpen(false);
  f.a.requests[0]!.resolve({ results: [f.hit("arrived-during-handoff")] });
  await Promise.resolve();
  assert.doesNotThrow(f.changed);
  assert.equal(view.getSnapshot().data.results.length, 0);
  f.setDatabaseOpen(true);
  canProject = true;
  f.owner.resumeProjection();
  await f.wait(() => view.getSnapshot().data.results.length === 1);
  assert.equal(view.getSnapshot().data.results[0]?.hit.title, "arrived-during-handoff");
  view.release();
});

test("matching callers share work while available results publish before a slow source", async context => {
  const f = fixture(); context.after(() => f.owner.dispose());
  const one = f.observe();
  const two = f.observe();
  assert.equal(f.a.requests.length, 1);
  assert.equal(f.b.requests.length, 1);
  f.a.requests[0].resolve({ results: [f.hit("first")] });
  await f.wait(() => one.getSnapshot().data.results.length === 1);
  assert.equal(two.getSnapshot().data.results.length, 1);
  assert.equal(one.getSnapshot().sources.find(source => source.daemonId === f.b.id)?.phase, "pending");
  one.release();
  two.release();
  assert.equal(f.a.leases, 0);
  assert.equal(f.b.leases, 0);
});

test("reconnect restores the read while unrelated publications neither requery nor erase results", async context => {
  const f = fixture(); context.after(() => f.owner.dispose());
  const view = f.observe();
  f.a.requests[0].resolve({ results: [f.hit("retained")] });
  f.b.requests[0].resolve({ results: [] });
  await f.wait(() => view.getSnapshot().phase === "current");
  f.changed();
  assert.equal(f.a.requests.length, 1);
  f.a.change({ connection: "reconnecting" });
  assert.equal(view.getSnapshot().data.results.length, 1);
  f.a.change({ connection: "current", generation: 2 });
  assert.equal(f.a.requests.length, 2);
  f.a.requests[1].resolve({ results: [f.hit("fresh")] });
  await f.wait(() => view.getSnapshot().phase === "current");
  assert.equal(view.getSnapshot().data.results[0].hit.title, "fresh");
  f.a.change({ connection: "revoked", failure: "Access revoked" });
  assert.equal(view.getSnapshot().data.results.length, 0);
  assert.equal(view.getSnapshot().sources.find(source => source.daemonId === f.a.id)?.phase, "unavailable");
});

test("hits from several daemons merge by score and a malformed hit drops only itself", async context => {
  const f = fixture(); context.after(() => f.owner.dispose());
  const view = f.observe();
  f.a.requests[0]!.resolve({ results: [{ ...f.hit("a-best"), score: 3 }, { ...f.hit("a-weak"), score: 1 },
    { kind: "thread", id: "broken" } as unknown as WorkbenchSearchResult] });
  f.b.requests[0]!.resolve({ results: [{ ...f.hit("b-middle"), score: 2 }] });
  await f.wait(() => view.getSnapshot().phase === "current");
  assert.deepEqual(view.getSnapshot().data.results.map(result => result.hit.title), ["a-best", "b-middle", "a-weak"]);
  assert.equal(f.warnings.length, 1);
});

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("each daemon runs one search at a time and never sends queries superseded while they waited", async context => {
  const f = fixture(); context.after(() => f.owner.dispose());
  let view = f.observe("c");
  for (const query of ["cl", "cla", "claude"]) {
    view.release();
    view = f.observe(query);
  }
  await settle();
  assert.deepEqual(f.a.requests.map(request => (request.params as { query: string }).query), ["c"]);
  f.a.requests[0]!.resolve({ results: [f.hit("stale")] });
  await settle();
  assert.deepEqual(f.a.requests.map(request => (request.params as { query: string }).query), ["c", "claude"]);
  f.a.requests[1]!.resolve({ results: [f.hit("current")] });
  await f.wait(() => view.getSnapshot().data.results.length === 1);
  assert.equal(view.getSnapshot().data.results[0]!.hit.title, "current");
});

test("kind and project filters hold even for daemons that ignore them, corrections merge, and checkouts share files", async context => {
  const f = fixture(); context.after(() => f.owner.dispose());
  const elsewhere = LogicalProjectIdSchema.parse(randomUUID());
  f.presentation.projects.push({ id: elsewhere, matchKey: "elsewhere", label: "Elsewhere" });
  f.presentation.locations.push({ target: { daemonId: f.a.id, projectId: ProjectIdSchema.parse("other") },
    logicalProjectId: elsewhere, identityKey: "elsewhere", name: "Elsewhere", rootPath: "/elsewhere" });
  const view = f.owner.observe({ projectId: f.presentation.projects[0]!.id, query: "stach", kinds: ["file", "thread"], projectOnly: true }, () => {});
  const file = (source: string): WorkbenchSearchResult => ({ kind: "file", id: `file:${source}`, path: "src/a.ts", projectId: "project", title: "a.ts", detail: "src", score: 1 });
  f.a.requests[0]!.resolve({ corrections: [{ from: "stach", to: "starch" }], results: [
    file("a"), f.hit("here"), { ...f.hit("elsewhere"), projectId: "other" },
    { kind: "action", actionId: "home", id: "action:home", title: "Home", detail: "" },
  ] });
  f.b.requests[0]!.resolve({ corrections: [{ from: "stach", to: "starch" }], results: [file("b")] });
  await settle();
  assert.equal(view.getSnapshot().phase, "current");
  assert.deepEqual(view.getSnapshot().data.results.map(result => result.hit.kind + ":" + result.hit.title).sort(), ["file:a.ts", "thread:here"]);
  assert.deepEqual(view.getSnapshot().data.corrections, [{ from: "stach", to: "starch" }]);
  view.release();
});

test("file hits from older daemons read as name over folder, and an empty query lists no files", async context => {
  const f = fixture(); context.after(() => f.owner.dispose());
  const legacy: WorkbenchSearchResult = { kind: "file", id: "file:deep", path: "src/deep/a.ts", projectId: "project", title: "src/deep/a.ts", detail: "project" };
  const typed = f.observe("a");
  f.a.requests[0]!.resolve({ results: [legacy] });
  f.b.requests[0]!.resolve({ results: [] });
  await settle();
  assert.deepEqual(typed.getSnapshot().data.results.map(({ hit }) => [hit.title, hit.detail]), [["a.ts", "src/deep"]]);
  typed.release();
  const empty = f.observe("");
  await settle();
  f.a.requests.at(-1)!.resolve({ results: [legacy, f.hit("recent")] });
  f.b.requests.at(-1)!.resolve({ results: [] });
  await settle();
  assert.deepEqual(empty.getSnapshot().data.results.map(({ hit }) => hit.kind), ["thread"]);
  empty.release();
});

test("failure stays scoped without retry spam and released requests cannot contaminate a replacement", async context => {
  const f = fixture(); context.after(() => f.owner.dispose());
  const old = f.observe("old");
  old.release();
  const view = f.observe("new");
  f.a.requests[0].resolve({ results: [f.hit("obsolete")] });
  f.b.requests[0].resolve({ results: [f.hit("obsolete")] });
  await settle();
  f.a.requests[1].resolve({ results: [] });
  f.b.requests[1].reject(new Error("Unavailable index"));
  await f.wait(() => view.getSnapshot().sources.some(source => source.phase === "failed"));
  assert.equal(view.getSnapshot().phase, "current", "one failed source with an empty answer elsewhere is no failure");
  assert.deepEqual(view.getSnapshot().data.results, []);
  assert.equal(f.warnings.length, 1);
  f.changed();
  assert.equal(f.b.requests.length, 2);
  assert.equal(view.getSnapshot().data.results.length, 0);
});
