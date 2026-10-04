/* No production exports. Protect machine-wide expensive-command admission: bounded slots, FIFO order, memory pressure and queued cancellation. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchCommandCapacity, { expensiveCommandSlots } from "./WorkbenchCommandCapacity";

const GB = 1_073_741_824;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

function fixture(slots: number) {
  const memory = { free: 20 * GB, total: 28 * GB };
  const lines: string[] = [];
  const rechecks: Array<() => void> = [];
  const capacity = new WorkbenchCommandCapacity({
    slots, readMemory: () => memory, log: line => lines.push(line.replace(/\u001b\[[0-9;]*m/gu, "")),
    // Like a real timer: firing or cancelling removes it.
    schedule: recheck => {
      const remove = () => { const index = rechecks.indexOf(fire); if (index >= 0) rechecks.splice(index, 1); };
      const fire = () => { remove(); recheck(); };
      rechecks.push(fire);
      return remove;
    },
  });
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const run = (name: string, signal = new AbortController().signal) => capacity.run(name, signal, async () => {
    started.push(name);
    const done = deferred();
    finish.set(name, done.resolve);
    await done.promise;
    return name;
  });
  return { capacity, memory, lines, rechecks, started, finish, run };
}

test("slots follow whichever of cores or memory runs out first, and never drop below one", () => {
  assert.equal(expensiveCommandSlots({ cores: 16, totalMemory: 28 * GB }), 3);
  assert.equal(expensiveCommandSlots({ cores: 32, totalMemory: 16 * GB }), 2);
  assert.equal(expensiveCommandSlots({ cores: 2, totalMemory: 4 * GB }), 1);
});

test("expensive commands beyond the slot count wait, then start in arrival order as slots free", async () => {
  const f = fixture(2);
  const runs = ["a", "b", "c", "d"].map(name => f.run(name));
  await Promise.resolve();
  assert.deepEqual(f.started, ["a", "b"]);
  f.finish.get("b")!();
  assert.equal(await runs[1], "b");
  await Promise.resolve();
  assert.deepEqual(f.started, ["a", "b", "c"]);
  f.finish.get("a")!();
  f.finish.get("c")!();
  await Promise.all([runs[0], runs[2]]);
  await Promise.resolve();
  assert.deepEqual(f.started, ["a", "b", "c", "d"]);
  f.finish.get("d")!();
  await runs[3];
  assert.match(f.lines.join("\n"), /queued \(1 ahead, 2 running: d\)/u);
});

test("memory pressure holds back a second command but never the only one, and a recheck admits it once memory recovers", async () => {
  const f = fixture(3);
  f.memory.free = 2 * GB;
  const first = f.run("first");
  const second = f.run("second");
  await Promise.resolve();
  assert.deepEqual(f.started, ["first"], "one expensive command always runs, even under pressure");
  assert.match(f.lines.join("\n"), /waiting for memory \(2\.0\/28GB free: second\)/u);
  assert.equal(f.rechecks.length, 1);
  f.rechecks[0]!();
  await Promise.resolve();
  assert.deepEqual(f.started, ["first"], "still under pressure");
  f.memory.free = 10 * GB;
  f.rechecks[0]!();
  await Promise.resolve();
  assert.deepEqual(f.started, ["first", "second"]);
  assert.equal(f.rechecks.length, 0, "no recheck runs once nothing waits");
  f.finish.get("first")!();
  f.finish.get("second")!();
  await Promise.all([first, second]);
});

test("cancelling a queued command leaves the queue without ever starting it", async () => {
  const f = fixture(1);
  const first = f.run("first");
  const abort = new AbortController();
  const queued = f.run("second", abort.signal);
  abort.abort(new Error("caller cancelled"));
  await assert.rejects(queued, /caller cancelled/u);
  await Promise.resolve();
  f.finish.get("first")!();
  await first;
  const third = f.run("third");
  await Promise.resolve();
  f.finish.get("third")!();
  await third;
  assert.deepEqual(f.started, ["first", "third"]);
});

test("a failing command still releases its slot", async () => {
  const f = fixture(1);
  await assert.rejects(f.capacity.run("boom", new AbortController().signal, async () => { throw new Error("boom"); }), /boom/u);
  assert.equal(await f.capacity.run("next", new AbortController().signal, async () => "ok"), "ok");
});
