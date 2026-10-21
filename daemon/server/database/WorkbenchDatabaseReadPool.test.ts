/* No production exports. Protect reader boot-before-open, dispatch order, the interactive reserve, queued-read abandonment, draining close that abandons background reads, and crash failure. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import WorkbenchDatabaseReadPool from "./WorkbenchDatabaseReadPool";
import type { WorkbenchDatabaseReadClass, WorkbenchDatabaseRequest, WorkbenchDatabaseResponse } from "./workbench-database-protocol";

class FakeReader extends EventEmitter {
  readonly posted: WorkbenchDatabaseRequest[] = [];
  terminated = false;
  constructor(private readonly sent: number[]) { super(); }
  postMessage(message: WorkbenchDatabaseRequest) {
    this.posted.push(message);
    this.sent.push(message.id);
  }
  async terminate() { this.terminated = true; return 0; }
  async getHeapStatistics() { return { used_heap_size: 1, total_heap_size: 2 }; }
  /** Finishes the read this reader is running. */
  answer(id = this.posted.at(-1)!.id) {
    this.emit("message", { id, type: "result", result: [] } satisfies WorkbenchDatabaseResponse);
  }
}

async function fixture(size = 3) {
  const readers: FakeReader[] = [];
  const sent: number[] = [];
  const settled: number[] = [];
  const failures: unknown[] = [];
  const pool = new WorkbenchDatabaseReadPool({
    create: () => { const reader = new FakeReader(sent); readers.push(reader); return reader; },
    settle: (response) => settled.push(response.id),
    fail: (error) => failures.push(error),
    size,
  });
  await pool.open(async () => {});
  let next = 1;
  const read = (readClass: WorkbenchDatabaseReadClass, signal?: AbortSignal) => {
    const id = next++;
    const abandoned: unknown[] = [];
    pool.run({ id, type: "call", name: "getInventory", args: [] }, readClass, { signal, abandon: (reason) => abandoned.push(reason) });
    return { id, abandoned };
  };
  /** Every read sent to a reader, in send order. */
  const running = () => [...sent];
  const busy = (id: number) => readers.find((reader) => reader.posted.some((request) => request.id === id))!;
  return { pool, readers, settled, failures, read, running, busy };
}

test("background reads fan out across idle readers but always leave one free for interactive work", async () => {
  const f = await fixture(3);
  const stats = [f.read("stats"), f.read("stats"), f.read("stats")];
  // Two of three readers take stats sections at once; the third waits for interactive reads.
  assert.deepEqual(f.running(), [stats[0]!.id, stats[1]!.id]);
  const sidebar = f.read("core");
  assert.deepEqual(f.running(), [stats[0]!.id, stats[1]!.id, sidebar.id], "an interactive read starts on the reserved reader at once");
  f.busy(sidebar.id).answer();
  assert.deepEqual(f.running(), [stats[0]!.id, stats[1]!.id, sidebar.id], "the freed reader is still the last one free");
  f.busy(stats[0]!.id).answer(stats[0]!.id);
  assert.ok(f.running().includes(stats[2]!.id));
});

test("a freed reader takes the most urgent queued read, then the earliest within a class", async () => {
  const f = await fixture(2);
  const first = f.read("core");
  const second = f.read("core");
  const query = f.read("query");
  const later = f.read("core");
  const live = f.read("transcript");
  assert.deepEqual(f.running(), [first.id, second.id]);
  f.busy(first.id).answer(first.id);
  assert.equal(f.running().at(-1), live.id, "the live transcript read jumps the earlier core and query reads");
  f.busy(second.id).answer(second.id);
  assert.equal(f.running().at(-1), later.id, "core reads stay in arrival order and still beat the background query");
  f.busy(live.id).answer(live.id);
  f.busy(later.id).answer(later.id);
  assert.equal(f.running().at(-1), query.id);
});

test("an abandoned queued read is never sent, while a running one still finishes", async () => {
  const f = await fixture(2);
  const runningRead = new AbortController();
  const queuedRead = new AbortController();
  const first = f.read("core", runningRead.signal);
  f.read("core");
  const stale = f.read("stats", queuedRead.signal);
  queuedRead.abort(new Error("released"));
  runningRead.abort(new Error("too late"));
  assert.equal((stale.abandoned[0] as Error).message, "released");
  assert.deepEqual(first.abandoned, []);
  f.busy(first.id).answer(first.id);
  assert.ok(f.settled.includes(first.id));
  assert.ok(!f.running().includes(stale.id));
  const already = new AbortController();
  already.abort(new Error("gone"));
  assert.equal((f.read("stats", already.signal).abandoned[0] as Error).message, "gone");
});

test("close lets queued and running reads finish before closing every reader", async () => {
  const f = await fixture(2);
  const first = f.read("core");
  const queued = f.read("core");
  const third = f.read("core");
  let closed = 0;
  const closing = f.pool.close(async () => { closed += 1; });
  await Promise.resolve();
  assert.equal(closed, 0);
  assert.equal(f.pool.ready, false, "new reads go to the writer, so steady traffic cannot hold the drain open");
  f.busy(first.id).answer(first.id);
  f.busy(queued.id).answer(queued.id);
  f.busy(third.id).answer(third.id);
  await closing;
  assert.equal(closed, 2);
  assert.ok(f.readers.every(({ terminated }) => terminated));
  assert.equal(f.pool.ready, false);
});

test("close abandons running and queued background reads instead of waiting on them, while interactive reads drain", async () => {
  const f = await fixture(3);
  const scan = f.read("stats");
  const interactive = f.read("core");
  const waiting = f.read("stats");
  let closed = 0;
  const closing = f.pool.close(async () => { closed += 1; });
  assert.match(String(scan.abandoned[0]), /closing/u, "the running scan's caller is released at once");
  assert.match(String(waiting.abandoned[0]), /closing/u);
  assert.ok(f.busy(scan.id).terminated, "its reader is terminated, since SQLite cannot interrupt the scan");
  assert.ok(!f.running().includes(waiting.id));
  await Promise.resolve();
  assert.equal(closed, 0, "the interactive read still drains");
  f.busy(interactive.id).answer(interactive.id);
  await closing;
  assert.equal(closed, 2, "only readers that were not terminated receive a close");
  assert.ok(f.readers.every(({ terminated }) => terminated));
  assert.deepEqual(f.failures, [], "terminating an abandoned reader is not an unexpected exit");
  f.busy(scan.id).emit("exit", 1);
  assert.deepEqual(f.failures, []);
});

test("readers boot before open, open initializes those same readers, and an unopened close only terminates them", async () => {
  const readers: FakeReader[] = [];
  const create = () => { const reader = new FakeReader([]); readers.push(reader); return reader; };
  const pool = new WorkbenchDatabaseReadPool({ create, settle: () => {}, fail: () => {}, size: 2 });
  assert.equal(readers.length, 2, "readers start booting while the writer prepares");
  const initialized: FakeReader[] = [];
  await pool.open(async (reader) => { initialized.push(reader as FakeReader); });
  assert.deepEqual(initialized, readers);
  assert.equal(readers.length, 2);

  const unopened = new WorkbenchDatabaseReadPool({ create, settle: () => {}, fail: () => {}, size: 2 });
  let closeRequests = 0;
  await unopened.close(async () => { closeRequests += 1; });
  assert.equal(closeRequests, 0, "booting readers hold no connection to close");
  assert.ok(readers.slice(2).every(({ terminated }) => terminated));
});

test("an unexpected reader exit fails the owner, but closing or terminating does not", async () => {
  const f = await fixture(2);
  f.readers[0]!.emit("exit", 1);
  assert.match(String(f.failures[0]), /exited unexpectedly with code 1/u);
  await f.pool.terminate();
  f.readers[1]!.emit("exit", 1);
  assert.equal(f.failures.length, 1);
  assert.equal(f.pool.ready, false);
});
