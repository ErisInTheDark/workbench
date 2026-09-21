/* No production exports. Protect idle assessment, commit fencing and reload disposal. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchDaemonSleepController from "./WorkbenchDaemonSleepController";
import type { DaemonSleepMessage } from "workbench-shared/http/workbench-daemon-lifecycle";

function fixture() {
  const state = { demand: false, connected: false, idle: true };
  const sent: DaemonSleepMessage[] = [];
  const commits: string[] = [];
  let check: (() => void) | null = null;
  const owner = new WorkbenchDaemonSleepController({
    demanded: () => state.demand, connected: () => state.connected, idle: () => state.idle,
    send: async message => { sent.push(message); }, commit: async id => { commits.push(id); },
    warn: message => { throw new Error(message); },
    schedule: next => { check = next; return () => { if (check === next) check = null; }; },
  });
  return { owner, state, sent, commits, tick() {
    const next = check;
    assert.ok(next);
    check = null;
    next();
  }, get scheduled() { return check !== null; }, request() {
    const message = sent.at(-1);
    assert.equal(message?.type, "workbench-daemon-sleep-request");
    return message!.id;
  } };
}

test("unattended active work remains alive until idle, and commit rechecks it", async () => {
  const f = fixture();
  f.state.idle = false;
  f.owner.refresh();
  f.tick();
  assert.equal(f.sent.length, 0);
  f.state.idle = true;
  f.tick();
  const id = f.request();
  f.state.idle = false;
  f.owner.receive({ type: "workbench-daemon-sleep-commit", id, allowed: true });
  assert.deepEqual(f.commits, []);
  assert.equal(f.sent.at(-1)?.type, "workbench-daemon-sleep-result");
  f.state.idle = true;
  f.tick();
  f.owner.receive({ type: "workbench-daemon-sleep-commit", id: f.request(), allowed: true });
  assert.equal(f.commits.length, 1);
  assert.equal(f.scheduled, false);
  await f.owner.dispose();
});

test("connected apps stop checks and late commitment cannot kill returning work", async () => {
  const f = fixture();
  f.state.connected = true;
  f.owner.refresh();
  assert.equal(f.scheduled, false);
  f.state.connected = false;
  f.owner.refresh(); f.tick();
  const id = f.request();
  f.state.demand = true;
  f.owner.refresh();
  f.owner.receive({ type: "workbench-daemon-sleep-commit", id, allowed: true });
  assert.deepEqual(f.commits, []);
  assert.equal(f.scheduled, false);
  await f.owner.dispose();
});

test("reload suspends a pending handshake and failed reload can resume assessment", async () => {
  const f = fixture();
  f.owner.refresh(); f.tick();
  const id = f.request();
  await f.owner.suspend();
  f.owner.receive({ type: "workbench-daemon-sleep-commit", id, allowed: true });
  assert.equal(f.scheduled, false);
  assert.deepEqual(f.commits, []);
  f.owner.resume();
  assert.equal(f.scheduled, true);
  await f.owner.dispose();
  assert.equal(f.scheduled, false);
});

test("an idle-reader failure releases the host fence and disables sleep instead of killing work", async () => {
  let check!: () => void;
  let broken = false;
  const sent: DaemonSleepMessage[] = [];
  const warnings: string[] = [];
  const owner = new WorkbenchDaemonSleepController({
    demanded: () => false, connected: () => false,
    idle: () => { if (broken) throw new Error("owner unavailable"); return true; },
    send: async message => { sent.push(message); },
    commit: async () => assert.fail("Failed idleness cannot commit shutdown."),
    warn: message => { warnings.push(message); },
    schedule: callback => { check = callback; return () => {}; },
  });
  owner.refresh(); check();
  const id = sent[0]!.id;
  broken = true;
  owner.receive({ type: "workbench-daemon-sleep-commit", id, allowed: true });
  assert.deepEqual(sent.at(-1), { type: "workbench-daemon-sleep-result", id, accepted: false });
  assert.equal(warnings.length, 1);
  await owner.dispose();
});
