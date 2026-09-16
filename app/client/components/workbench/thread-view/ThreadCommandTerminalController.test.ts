/* No exports. Protect serialized terminal presentation, expansion, and animation disposal. */
import assert from "node:assert/strict";
import test from "node:test";
import ThreadCommandTerminalController from "./ThreadCommandTerminalController";
import type { ThreadTerminalEntry } from "./thread-live-activity";

function entry(id: string, status: ThreadTerminalEntry["status"] = "inProgress"): ThreadTerminalEntry {
  return { id, command: id, output: "", status, streamsOutput: false, display: null };
}
function fixture() {
  const batches: Array<{ finish: () => void; fail: () => void; cancelled: boolean }> = [];
  let warnings = 0;
  const controller = new ThreadCommandTerminalController({
    measure: () => new Map(),
    animate: () => {
      const batch = { finish: () => {}, fail: () => {}, cancelled: false };
      const finished = new Promise<Animation>((resolve, reject) => {
        batch.finish = () => resolve({} as Animation);
        batch.fail = () => reject(new Error("animation failed"));
      });
      batches.push(batch);
      return [{ finished, cancel: () => { batch.cancelled = true; } }];
    },
  }, () => { warnings++; });
  return { controller, batches, warnings: () => warnings };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

test("a burst waits for the entire active animation and publishes the latest complete order", async () => {
  const { controller, batches } = fixture();
  controller.setEntries([entry("a")]);
  controller.configure(true, false);
  controller.setEntries([entry("a"), entry("b")]);
  controller.committed();
  controller.setEntries([entry("a"), entry("b", "completed"), entry("c")]);
  controller.setEntries([entry("a", "completed"), entry("b", "completed"), entry("c")]);
  assert.deepEqual(controller.getSnapshot().map(row => [row.id, row.status]), [["a", "inProgress"], ["b", "inProgress"]]);
  assert.equal(batches[0]!.cancelled, false);
  batches[0]!.finish();
  await settle();
  assert.deepEqual(controller.getSnapshot().map(row => [row.id, row.status]), [["a", "completed"], ["b", "completed"], ["c", "inProgress"]]);
  controller.committed();
  batches[1]!.finish();
  await settle();
  controller.dispose();
});

test("completed calls move before remaining running calls without changing invocation order within either partition", () => {
  const { controller } = fixture();
  controller.setEntries([entry("first"), entry("second", "completed"), entry("third", "failed")]);
  assert.deepEqual(controller.getSnapshot().map(row => row.id), ["second", "third", "first"]);
});

test("output and expansion wait during motion and expansion survives later canonical updates", async () => {
  const { controller, batches } = fixture();
  controller.setEntries([{ ...entry("a"), streamsOutput: true }]);
  controller.configure(true, false);
  controller.setOutput("a", "one");
  controller.setEntries([{ ...entry("a"), streamsOutput: true }, entry("b")]);
  controller.committed();
  controller.setOutput("a", "one\ntwo");
  controller.expand("a", "output");
  assert.equal(controller.getSnapshot()[0]!.output, "one");
  assert.equal(controller.getSnapshot()[0]!.outputExpanded, false);
  batches[0]!.finish();
  await settle();
  assert.equal(controller.getSnapshot()[0]!.output, "one\ntwo");
  assert.equal(controller.getSnapshot()[0]!.outputExpanded, true);
  controller.configure(false, false);
  controller.setEntries([{ ...entry("a", "completed"), output: "final" }]);
  assert.equal(controller.getSnapshot()[0]!.outputExpanded, true);
});

test("text, expansion and non-reordering outcomes publish without starting geometry work", () => {
  let measurements = 0;
  const controller = new ThreadCommandTerminalController({
    measure: () => { measurements++; return new Map(); },
    animate: () => { throw new Error("no movement to animate"); },
  });
  controller.setEntries([{ ...entry("a"), streamsOutput: true }]);
  controller.configure(true, false);
  controller.setOutput("a", "partial");
  controller.expand("a", "output");
  assert.equal(controller.getSnapshot()[0]!.output, "partial");
  assert.equal(controller.getSnapshot()[0]!.outputExpanded, true);
  controller.setEntries([{ ...entry("a", "failed"), output: "final" }]);
  assert.equal(controller.getSnapshot()[0]!.status, "failed");
  assert.equal(controller.getSnapshot()[0]!.output, "final");
  assert.equal(measurements, 0);
  controller.dispose();
});

test("reduced motion and closing flush pending changes without waiting on cancelled motion", async () => {
  for (const [visible, reduced] of [[true, true], [false, false]]) {
    const { controller, batches, warnings } = fixture();
    controller.setEntries([entry("a")]);
    controller.configure(true, false);
    controller.setEntries([entry("a"), entry("b")]);
    controller.committed();
    controller.setEntries([entry("a", "completed")]);
    controller.configure(visible!, reduced!);
    assert.equal(batches[0]!.cancelled, true);
    assert.equal(controller.getSnapshot()[0]!.status, "completed");
    batches[0]!.fail();
    await settle();
    assert.equal(warnings(), 0);
  }
});

test("unexpected animation failure warns once and leaves the latest data usable without motion", async () => {
  const { controller, batches, warnings } = fixture();
  controller.setEntries([entry("a")]);
  controller.configure(true, false);
  controller.setEntries([entry("a"), entry("b")]);
  controller.committed();
  controller.setEntries([entry("a", "completed")]);
  batches[0]!.fail();
  await settle();
  assert.equal(warnings(), 1);
  assert.equal(controller.getSnapshot()[0]!.status, "completed");
  controller.setEntries([entry("c")]);
  controller.committed();
  assert.equal(batches.length, 1);
});

test("disposal cancels owned motion and ignores late completions and updates", async () => {
  const { controller, batches, warnings } = fixture();
  controller.setEntries([entry("a")]);
  controller.configure(true, false);
  controller.setEntries([entry("a"), entry("b")]);
  controller.committed();
  const snapshot = controller.getSnapshot();
  controller.dispose();
  controller.setEntries([entry("c")]);
  batches[0]!.fail();
  await settle();
  assert.equal(batches[0]!.cancelled, true);
  assert.equal(controller.getSnapshot(), snapshot);
  assert.equal(warnings(), 0);
});

test("a batch remains locked until every moving row finishes", async () => {
  const finish: Array<() => void> = [];
  const controller = new ThreadCommandTerminalController({
    measure: () => new Map(),
    animate: () => [0, 1].map(() => ({
      finished: new Promise<Animation>(resolve => { finish.push(() => resolve({} as Animation)); }),
      cancel: () => {},
    })),
  });
  controller.setEntries([entry("a")]);
  controller.configure(true, false);
  controller.setEntries([entry("a"), entry("b")]);
  controller.committed();
  controller.setEntries([entry("a", "completed"), entry("b", "completed")]);
  finish[0]!();
  await settle();
  assert.equal(controller.getSnapshot()[0]!.status, "inProgress");
  finish[1]!();
  await settle();
  assert.equal(controller.getSnapshot()[0]!.status, "completed");
  controller.dispose();
});

test("history expiry waits behind movement and does not interrupt the running-call completion", async () => {
  const { controller, batches } = fixture();
  controller.setEntries([entry("expired", "completed"), entry("running")]);
  controller.configure(true, false);
  controller.setEntries([entry("expired", "completed"), entry("running"), entry("new")]);
  controller.committed();
  controller.setEntries([entry("running", "completed"), entry("new")]);
  assert.deepEqual(controller.getSnapshot().map(row => row.id), ["expired", "running", "new"]);
  assert.equal(batches[0]!.cancelled, false);
  batches[0]!.finish();
  await settle();
  assert.deepEqual(controller.getSnapshot().map(row => [row.id, row.status]), [["running", "completed"], ["new", "inProgress"]]);
  controller.dispose();
});

test("measurement and animation construction failures cannot strand pending state", () => {
  for (const failure of ["measure", "animate"]) {
    let warnings = 0;
    const controller = new ThreadCommandTerminalController({
      measure: () => { if (failure === "measure") throw new Error("measurement"); return new Map(); },
      animate: () => { throw new Error("construction"); },
    }, () => { warnings++; });
    controller.setEntries([entry("a")]);
    controller.configure(true, false);
    controller.setEntries([entry("a"), entry("b")]);
    controller.committed();
    controller.setEntries([entry("a", "completed")]);
    assert.equal(warnings, 1);
    assert.equal(controller.getSnapshot()[0]!.status, "completed");
  }
});
