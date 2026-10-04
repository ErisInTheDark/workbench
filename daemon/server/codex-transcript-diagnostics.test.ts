/*
 * Exports:
 * - No production exports; Node tests protect healthy silence, backlog and age anomalies, compact evidence, repeat throttling, and memory reads only for emitted lines.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createCodexTranscriptDiagnostic } from "./codex-transcript-diagnostics";

const usage = { heapTotal: 323 * 1_024 * 1_024, heapUsed: 285 * 1_024 * 1_024, rss: 378 * 1_024 * 1_024 };
const memory = () => usage;

test("keeps healthy and idle transcript queues silent", () => {
  assert.equal(createCodexTranscriptDiagnostic({ lastLoggedAt: null, memory, now: 10_000, pending: { count: 0, oldest: undefined } }), null);
  assert.equal(createCodexTranscriptDiagnostic({
    lastLoggedAt: null,
    memory,
    now: 10_000,
    pending: { count: 1, oldest: { label: "upstream-response:thread/read", startedAt: 5_001 } },
  }), null);
});

test("reports a large queue or an old task with current evidence only", () => {
  const large = createCodexTranscriptDiagnostic({
    lastLoggedAt: null,
    memory,
    now: 1_000,
    pending: { count: 25, oldest: { label: "task-0", startedAt: 900 } },
  });
  assert.ok(large);
  assert.match(large.message, /pending=25/u);

  const old = createCodexTranscriptDiagnostic({
    lastLoggedAt: null,
    memory,
    now: 10_000,
    pending: { count: 2, oldest: { label: "oldest-task", startedAt: 5_000 } },
  });
  assert.ok(old);
  assert.match(old.message, /oldest=oldest-task age=5\.0s rss=378MB heap=285MB\/323MB/u);
  assert.doesNotMatch(old.message, /enqueued|completed|failed|autoRefreshSkipped|lastSkipped|top=/u);
});

test("throttles repeats without hiding a continuing anomaly", () => {
  const input = {
    memory,
    pending: { count: 1, oldest: { label: "oldest", startedAt: 0 } },
  };
  assert.equal(createCodexTranscriptDiagnostic({ ...input, lastLoggedAt: 10_000, now: 14_999 }), null);
  assert.ok(createCodexTranscriptDiagnostic({ ...input, lastLoggedAt: 10_000, now: 15_000 }));
});

test("reads process memory only for a line it emits", () => {
  let reads = 0;
  const counted = () => { reads += 1; return usage; };
  const backlog = { count: 30, oldest: { label: "oldest", startedAt: 0 } };
  createCodexTranscriptDiagnostic({ lastLoggedAt: 10_000, memory: counted, now: 12_000, pending: backlog });
  createCodexTranscriptDiagnostic({ lastLoggedAt: null, memory: counted, now: 100, pending: { count: 1, oldest: { label: "fresh", startedAt: 50 } } });
  assert.equal(reads, 0);
  assert.ok(createCodexTranscriptDiagnostic({ lastLoggedAt: null, memory: counted, now: 12_000, pending: backlog }));
  assert.equal(reads, 1);
});
