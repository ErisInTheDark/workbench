/*
 * No exports. Protects how `wb view` reads repair state and routes cancel/retry to the right repair.
 */
import assert from "node:assert/strict";
import test from "node:test";
import createWorkbenchRepairViewControls, { repairViewSnapshot } from "./WorkbenchRepairViewControls.ts";
import type { RepairActivity } from "../scripts/installation/update-repair.mjs";
import type { InstallationRepairJournal } from "../shared/workbench/installation-update.ts";

const journal = (phase: InstallationRepairJournal["phase"]): InstallationRepairJournal => ({
  version: 1, id: "3a343847-c6cf-4c35-97f0-71873090a8da", phase, fromSha: null, toSha: null,
  logPath: "/repo/.workbench/logs/workbench-update-1.log", lastError: phase === "done" ? null : "Cancelled.",
  createdAt: 1, updatedAt: 1, failure: null,
});
const owner = { pid: 42, token: "owner-42-3a343847-c6cf-4c35-97f0-71873090a8da" };

test("a live lock owner means running; an unfinished journal alone means pending", () => {
  assert.equal(repairViewSnapshot({ journal: journal("installing"), owner }).state, "running");
  assert.equal(repairViewSnapshot({ journal: journal("installing"), owner: null }).state, "pending");
  assert.equal(repairViewSnapshot({ journal: journal("stranded"), owner: null }).state, "pending");
  assert.equal(repairViewSnapshot({ journal: journal("done"), owner: null }).state, "idle");
  assert.equal(repairViewSnapshot({ journal: null, owner: null }).state, "idle");
});

async function controls(activity: RepairActivity) {
  const events: string[] = [];
  let tick = () => {};
  const state = { activity };
  const owner = await createWorkbenchRepairViewControls({
    dataRoot: "/data", repositoryRoot: "/repo",
    read: async () => state.activity,
    cancel: async token => { events.push(`cancel:${token}`); },
    startRepair: () => { events.push("start"); },
    every: (_ms, next) => { tick = next; return () => {}; },
  });
  return { owner, events, state, tick: () => tick() };
}

test("cancel targets the live owner's token and retry refuses while a repair runs", async () => {
  const c = await controls({ journal: journal("installing"), owner });
  await c.owner.cancel();
  await assert.rejects(c.owner.retry(), /already running/u);
  assert.deepEqual(c.events, [`cancel:${owner.token}`]);

  c.state.activity = { journal: journal("installing"), owner: null };
  await assert.rejects(c.owner.cancel(), /No dependency repair is running/u);
  await c.owner.retry();
  assert.deepEqual(c.events, [`cancel:${owner.token}`, "start"]);
});

test("an unreadable journal stays retryable instead of looking idle", async () => {
  const failing = await createWorkbenchRepairViewControls({
    dataRoot: "/data", repositoryRoot: "/repo",
    read: async () => { throw new Error("journal is invalid"); },
    every: () => () => {},
  });
  assert.equal(failing.snapshot().state, "pending");
  assert.match(failing.snapshot().lastError ?? "", /journal is invalid/u);
});

test("full controls wait until the repair finishes", async () => {
  const c = await controls({ journal: journal("installing"), owner });
  let idle = false;
  const waiting = c.owner.whenIdle(new AbortController().signal).then(() => { idle = true; });
  c.state.activity = { journal: journal("done"), owner: null };
  c.tick();
  await waiting;
  assert.equal(idle, true);
});
