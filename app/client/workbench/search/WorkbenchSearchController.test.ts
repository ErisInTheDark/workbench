/* No exports. Protect query replacement, partial selection and disposal without timer races. */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchSearchController from "./WorkbenchSearchController";
import type { WorkspaceQuerySnapshot } from "../app/WorkbenchWorkspaceClient";
import type { WorkbenchSearchResult } from "workbench-shared/workbench/search/workbench-search";

const home: WorkbenchSearchResult = { actionId: "home", detail: "", id: "home", kind: "action", title: "Home" };
const settings: WorkbenchSearchResult = { actionId: "settings", detail: "", id: "settings", kind: "action", title: "Settings" };

function snapshot(results: WorkbenchSearchResult[], phase: "pending" | "current" | "failed" = "current",
  failure: string | null = null): WorkspaceQuerySnapshot<"search"> {
  return { phase, failure, value: { kind: "search", subscriptionId: "search", generation: 1, revision: 1,
    phase, failure, sources: [], data: { results: results.map(hit => ({ hit })) } } };
}

function setup() {
  const scheduled = new Map<number, () => void>();
  let timerId = 0;
  const reads: Array<{
    request: { query: string; projectId: string | null };
    publish(snapshot: WorkspaceQuerySnapshot<"search">): void;
    released: boolean;
  }> = [];
  const activated: string[] = [];
  const controller = new WorkbenchSearchController({
    activate: result => activated.push(`${controller.getSnapshot().isOpen}:${result.id}`),
    clearTimeout: id => { scheduled.delete(Number(id)); },
    observe: (request, publish) => {
      const read = { request, publish, released: false };
      reads.push(read);
      return () => { read.released = true; };
    },
    setTimeout: callback => { scheduled.set(++timerId, callback); return timerId; },
  });
  const runScheduled = () => {
    for (const [id, callback] of [...scheduled]) { scheduled.delete(id); callback(); }
  };
  return { activated, controller, reads, runScheduled, scheduled };
}

test("coalesced replacement starts without waiting for an obsolete source and fences its late results", () => {
  const { controller, reads, runScheduled } = setup();
  controller.open();
  controller.setQuery("first");
  runScheduled();
  for (const query of ["second", "third", "latest"]) controller.setQuery(query);
  assert.equal(reads[0].released, true);
  runScheduled();
  assert.equal(reads.length, 2);
  assert.equal(reads[1].request.query, "latest");
  reads[0].publish(snapshot([home]));
  assert.deepEqual(controller.getSnapshot().results, []);
  reads[1].publish(snapshot([settings]));
  assert.deepEqual(controller.getSnapshot().results, [settings]);
  controller.dispose();
});

test("partial updates preserve selected identity when another source inserts results", () => {
  const { controller, reads, runScheduled, activated } = setup();
  controller.open();
  runScheduled();
  reads[0].publish(snapshot([settings], "pending"));
  assert.equal(controller.getSnapshot().isLoading, true);
  reads[0].publish(snapshot([home, settings]));
  assert.equal(controller.getSnapshot().selectedIndex, 1);
  assert.equal(controller.activateSelected(), true);
  assert.deepEqual(activated, ["false:settings"]);
  assert.equal(reads[0].released, true);
  controller.dispose();
});

test("editing clears actionable stale rows and current failures do not retry themselves", () => {
  const { controller, reads, runScheduled, scheduled, activated } = setup();
  controller.open();
  runScheduled();
  reads[0].publish(snapshot([settings]));
  controller.setQuery("new");
  controller.activate(settings);
  assert.equal(controller.activateSelected(), false);
  assert.deepEqual(activated, []);
  runScheduled();
  reads[1].publish(snapshot([], "failed", "Source failed"));
  assert.equal(controller.getSnapshot().error, "Source failed");
  assert.equal(controller.getSnapshot().isLoading, false);
  assert.equal(scheduled.size, 0);
  reads[1].publish(snapshot([home]));
  assert.equal(controller.getSnapshot().error, null);
  controller.dispose();
});

test("project changes and close/reopen replace intent immediately, disposal fences further updates", () => {
  const { controller, reads, runScheduled, scheduled } = setup();
  controller.open();
  runScheduled();
  controller.setProjectId("other");
  controller.close();
  controller.open();
  controller.setQuery("latest");
  runScheduled();
  assert.equal(reads.length, 2);
  assert.equal(reads[0].released, true);
  assert.deepEqual(reads[1].request, { projectId: "other", query: "latest" });
  reads[0].publish(snapshot([home]));
  assert.deepEqual(controller.getSnapshot().results, []);
  controller.dispose();
  const retired = controller.getSnapshot();
  reads[1].publish(snapshot([settings]));
  runScheduled();
  assert.equal(reads[1].released, true);
  assert.equal(controller.getSnapshot(), retired);
  assert.equal(scheduled.size, 0);
});
