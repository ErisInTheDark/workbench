/* Exports: none. Protect the memory breakdown line, stalled-sample marking, failure reporting and disposal. */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchMemoryReporter from "./WorkbenchMemoryReporter";

const MB = 1_048_576;

function fixture(readWorkerHeaps: () => Promise<Awaited<ReturnType<ConstructorParameters<typeof WorkbenchMemoryReporter>[0]["readWorkerHeaps"]>>>) {
  const logs: string[] = [];
  const warnings: string[] = [];
  let stopped = false;
  const reporter = new WorkbenchMemoryReporter({
    readProcess: () => ({ rss: 1083 * MB, heapUsed: 366 * MB, heapTotal: 412 * MB, external: 41 * MB, arrayBuffers: 12 * MB }),
    readWorkerHeaps,
    log: message => logs.push(message),
    warn: message => warnings.push(message),
    schedule: () => ({ stop: () => { stopped = true; } }),
  });
  return { reporter, logs, warnings, stopped: () => stopped };
}

test("one sample logs process and database worker memory in one line", async () => {
  const f = fixture(async () => ({ writer: { used: 88 * MB, total: 120 * MB }, core: { used: 61 * MB, total: 80 * MB }, transcript: null }));
  await f.reporter.tick();
  assert.deepEqual(f.logs, [
    "rss 1083MB | heap 366/412MB | external 41MB | arrayBuffers 12MB | db workers: writer 88/120MB, core 61/80MB, transcript off",
  ]);
});

test("a sample still pending at the next tick is marked instead of stacked", async () => {
  let reads = 0;
  let release!: () => void;
  const f = fixture(async () => {
    reads += 1;
    await new Promise<void>(resolve => { release = resolve; });
    return { writer: null, core: null, transcript: null };
  });
  const first = f.reporter.tick();
  await f.reporter.tick();
  assert.equal(reads, 1);
  assert.deepEqual(f.logs, ["previous sample still pending after 60s"]);
  release();
  await first;
  assert.equal(f.logs.length, 2);
});

test("failed samples warn once each and disposal stops the schedule", async () => {
  const f = fixture(async () => { throw new Error("worker gone"); });
  await f.reporter.tick();
  assert.deepEqual(f.warnings, ["memory sample failed: worker gone"]);
  f.reporter.dispose();
  assert.equal(f.stopped(), true);
  await f.reporter.tick();
  assert.equal(f.warnings.length, 1);
});
