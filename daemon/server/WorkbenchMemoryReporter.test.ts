/* Exports: none. Protect the memory breakdown line, stalled-sample marking, start-gated scheduling, failure reporting and disposal. */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchMemoryReporter from "./WorkbenchMemoryReporter";

const MB = 1_048_576;

function fixture(readWorkerHeaps: () => Promise<Awaited<ReturnType<ConstructorParameters<typeof WorkbenchMemoryReporter>[0]["readWorkerHeaps"]>>>) {
  const logs: string[] = [];
  const warnings: string[] = [];
  let stopped = false;
  let scheduled = 0;
  const reporter = new WorkbenchMemoryReporter({
    readProcess: () => ({ rss: 1083 * MB, heapUsed: 366 * MB, heapTotal: 412 * MB, external: 41 * MB, arrayBuffers: 12 * MB }),
    readWorkerHeaps,
    readSystem: () => ({ free: 3.6 * 1024 * MB, total: 28 * 1024 * MB }),
    log: message => logs.push(message),
    warn: message => warnings.push(message),
    schedule: () => { scheduled += 1; return { stop: () => { stopped = true; } }; },
  });
  return { reporter, logs, warnings, scheduled: () => scheduled, stopped: () => stopped };
}

test("one sample logs process and database worker memory in one line", async () => {
  const f = fixture(async () => ({ writer: { used: 88 * MB, total: 120 * MB }, core: { used: 61 * MB, total: 80 * MB }, transcript: null, query: null, stats: null }));
  await f.reporter.tick();
  assert.equal(f.logs.length, 1);
  const line = plain(f.logs[0]!);
  for (const part of ["heap 366/412MB", "rss 1083MB", "external 41MB", "writer 88/120MB", "core 61/80MB", "transcript off", "system free 3.6/28GB"]) {
    assert.ok(line.includes(part), `${part} missing from ${line}`);
  }
});

function plain(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

test("a sample still pending at the next tick is marked instead of stacked", async () => {
  let reads = 0;
  let release!: () => void;
  const f = fixture(async () => {
    reads += 1;
    await new Promise<void>(resolve => { release = resolve; });
    return { writer: null, core: null, transcript: null, query: null, stats: null };
  });
  const first = f.reporter.tick();
  await f.reporter.tick();
  assert.equal(reads, 1);
  assert.deepEqual(f.logs.map(plain), [" MEM sample still pending after 60s"]);
  release();
  await first;
  assert.equal(f.logs.length, 2);
});

test("failed samples warn once each and disposal stops the schedule", async () => {
  const f = fixture(async () => { throw new Error("worker gone"); });
  // Sampling waits for its owner's start, so a stalled startup stays silent for the host watchdog.
  assert.equal(f.scheduled(), 0);
  f.reporter.start();
  f.reporter.start();
  assert.equal(f.scheduled(), 1);
  await f.reporter.tick();
  assert.equal(f.warnings.length, 1);
  assert.match(plain(f.warnings[0]!), /MEM sample failed \(worker gone\)/u);
  f.reporter.dispose();
  assert.equal(f.stopped(), true);
  await f.reporter.tick();
  assert.equal(f.warnings.length, 1);
});
