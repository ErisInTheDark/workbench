/* No exports. Protect query replacement, the steady shown result set, filters, summary readiness and disposal without timer races. */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchSearchController, { SEARCH_DISPLAY_DEADLINE_MS } from "./WorkbenchSearchController";
import type { WorkspaceQuerySnapshot } from "../app/WorkbenchWorkspaceClient";
import type { WorkbenchSearchRequest, WorkbenchSearchResult } from "workbench-shared/workbench/search/workbench-search";

const home: WorkbenchSearchResult = { actionId: "home", detail: "", id: "home", kind: "action", title: "Home" };
const settings: WorkbenchSearchResult = { actionId: "settings", detail: "", id: "settings", kind: "action", title: "Settings" };
const thread = (id: string): WorkbenchSearchResult => ({ kind: "thread", id, threadId: id, projectId: "p", harnessId: "codex", title: id, detail: "" });

function snapshot(results: WorkbenchSearchResult[], phase: "pending" | "current" | "failed" = "current",
  failure: string | null = null): WorkspaceQuerySnapshot<"search"> {
  return { phase, failure, value: { kind: "search", subscriptionId: "search", generation: 1, revision: 1,
    phase, failure, sources: [], data: { results: results.map(hit => ({ hit })) } } };
}

function setup() {
  const scheduled = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const reads: Array<{
    request: WorkbenchSearchRequest;
    publish(snapshot: WorkspaceQuerySnapshot<"search">): void;
    released: boolean;
  }> = [];
  const activated: string[] = [];
  const known = new Set<string>();
  const summaryListeners = new Map<string, () => void>();
  const controller = new WorkbenchSearchController({
    clearTimeout: id => { scheduled.delete(Number(id)); },
    observe: (request, publish) => {
      const read = { request, publish, released: false };
      reads.push(read);
      return () => { read.released = true; };
    },
    setTimeout: (callback, delay) => { scheduled.set(++timerId, { callback, delay }); return timerId; },
    summaries: {
      get: () => null,
      has: threadId => known.has(threadId),
      subscribe: (threadId, listener) => {
        summaryListeners.set(threadId, listener);
        return () => { summaryListeners.delete(threadId); };
      },
    },
  });
  controller.onActivate(result => activated.push(`${controller.getSnapshot().isOpen}:${result.id}`));
  const run = (delay: number) => {
    for (const [id, timer] of [...scheduled]) if (timer.delay === delay) { scheduled.delete(id); timer.callback(); }
  };
  const debounce = () => run(80);
  const deadline = () => run(SEARCH_DISPLAY_DEADLINE_MS);
  const resolveSummary = (threadId: string) => { known.add(threadId); summaryListeners.get(threadId)?.(); };
  const titles = () => controller.getSnapshot().results.map(result => result.title);
  return { activated, controller, deadline, debounce, reads, resolveSummary, scheduled, summaryListeners, titles };
}

test("coalesced replacement starts without waiting for an obsolete source and fences its late results", () => {
  const { controller, reads, debounce } = setup();
  controller.open();
  controller.setQuery("first");
  debounce();
  for (const query of ["second", "third", "latest"]) controller.setQuery(query);
  assert.equal(reads[0].released, true);
  debounce();
  assert.equal(reads.length, 2);
  assert.equal(reads[1].request.query, "latest");
  reads[0].publish(snapshot([home]));
  assert.deepEqual(controller.getSnapshot().results, []);
  reads[1].publish(snapshot([settings]));
  assert.deepEqual(controller.getSnapshot().results, [settings]);
  controller.dispose();
});

test("earlier results stay up, stale, until the next set is complete with its thread summaries", () => {
  const { controller, reads, debounce, resolveSummary, titles } = setup();
  controller.open();
  debounce();
  reads[0].publish(snapshot([home]));
  controller.setQuery("claude");
  assert.deepEqual(titles(), ["Home"]);
  assert.equal(controller.getSnapshot().stale, true);
  debounce();
  reads[1].publish(snapshot([thread("partial")], "pending"));
  assert.deepEqual(titles(), ["Home"], "a partial answer does not replace the shown set");
  reads[1].publish(snapshot([thread("best"), thread("partial")]));
  assert.deepEqual(titles(), ["Home"], "thread rows wait for their summaries");
  resolveSummary("best");
  assert.deepEqual(titles(), ["Home"]);
  resolveSummary("partial");
  assert.deepEqual(titles(), ["best", "partial"]);
  assert.equal(controller.getSnapshot().stale, false);
  assert.equal(controller.getSnapshot().isLoading, false);
  controller.dispose();
});

test("the deadline shows a partial set, and later arrivals join it without moving shown rows", () => {
  const { controller, reads, debounce, deadline, titles } = setup();
  controller.open();
  debounce();
  reads[0].publish(snapshot([settings], "pending"));
  assert.deepEqual(titles(), []);
  deadline();
  assert.deepEqual(titles(), ["Settings"]);
  assert.equal(controller.getSnapshot().isLoading, true);
  controller.moveSelection(0);
  reads[0].publish(snapshot([home, settings]));
  assert.deepEqual(titles(), ["Settings", "Home"]);
  assert.equal(controller.getSnapshot().selectedIndex, 0);
  assert.equal(controller.getSnapshot().isLoading, false);
  controller.dispose();
});

test("enter on stale rows opens the first fresh result once shown; stale rows never activate", () => {
  const { controller, reads, debounce, activated } = setup();
  controller.open();
  debounce();
  reads[0].publish(snapshot([settings]));
  controller.setQuery("home");
  controller.activate(settings);
  assert.deepEqual(activated, []);
  assert.equal(controller.activateSelected(), true);
  debounce();
  reads[1].publish(snapshot([home]));
  assert.deepEqual(activated, ["false:home"]);
  controller.dispose();
});

test("failures show once complete and do not retry themselves", () => {
  const { controller, reads, debounce, scheduled } = setup();
  controller.open();
  debounce();
  reads[0].publish(snapshot([], "failed", "Source failed"));
  assert.equal(controller.getSnapshot().error, "Source failed");
  assert.equal(controller.getSnapshot().isLoading, false);
  scheduled.clear();
  reads[0].publish(snapshot([home]));
  assert.equal(controller.getSnapshot().error, null);
  assert.equal(scheduled.size, 0);
  controller.dispose();
});

test("kind and scope filters request at once, cycle with wrap-around, and only scope when a project is in view", () => {
  const { controller, reads, debounce } = setup();
  controller.open();
  debounce();
  controller.cycleKind(-1);
  assert.equal(controller.getSnapshot().kind, "action");
  assert.deepEqual(reads.at(-1)!.request, { projectId: null, query: "", kinds: ["action"] });
  controller.cycleKind(1);
  assert.equal(controller.getSnapshot().kind, null);
  controller.setProjectOnly(true);
  assert.deepEqual(reads.at(-1)!.request, { projectId: null, query: "" });
  controller.setProjectId("project");
  assert.deepEqual(reads.at(-1)!.request, { projectId: "project", query: "", projectOnly: true });
  controller.dispose();
});

test("project changes and close/reopen replace intent immediately, disposal fences further updates and releases leases", () => {
  const { controller, reads, debounce, scheduled, summaryListeners } = setup();
  controller.open();
  debounce();
  reads[0].publish(snapshot([thread("leased")], "pending"));
  assert.ok(summaryListeners.has("leased"));
  controller.setProjectId("other");
  controller.close();
  assert.equal(summaryListeners.size, 0);
  controller.open();
  controller.setQuery("latest");
  debounce();
  assert.equal(reads[0].released, true);
  assert.deepEqual(reads.at(-1)!.request, { projectId: "other", query: "latest" });
  reads[0].publish(snapshot([home]));
  assert.deepEqual(controller.getSnapshot().results, []);
  controller.dispose();
  const retired = controller.getSnapshot();
  reads.at(-1)!.publish(snapshot([settings]));
  assert.equal(reads.at(-1)!.released, true);
  assert.equal(controller.getSnapshot(), retired);
  assert.equal(scheduled.size, 0);
});
