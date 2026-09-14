/*
 * Exports:
 * - No production exports; Node tests protect healthy silence, backlog and age anomalies, compact evidence, and repeat throttling. Keywords: transcript, diagnostics, anomaly, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createCodexTranscriptDiagnostic } from "./codex-transcript-diagnostics";

const memory = { heapTotal: 323 * 1_024 * 1_024, heapUsed: 285 * 1_024 * 1_024, rss: 378 * 1_024 * 1_024 };

test("keeps healthy and idle transcript queues silent", () => {
  assert.equal(createCodexTranscriptDiagnostic({ lastLoggedAt: null, memory, now: 10_000, pending: [] }), null);
  assert.equal(createCodexTranscriptDiagnostic({
    lastLoggedAt: null,
    memory,
    now: 10_000,
    pending: [{ label: "upstream-response:thread/read", startedAt: 5_001 }],
  }), null);
});

test("reports a large queue or an old task with current evidence only", () => {
  const large = createCodexTranscriptDiagnostic({
    lastLoggedAt: null,
    memory,
    now: 1_000,
    pending: Array.from({ length: 25 }, (_, index) => ({ label: `task-${index}`, startedAt: 900 })),
  });
  assert.ok(large);
  assert.match(large.message, /pending=25/u);

  const old = createCodexTranscriptDiagnostic({
    lastLoggedAt: null,
    memory,
    now: 10_000,
    pending: [
      { label: "newer", startedAt: 8_000 },
      { label: "oldest-task", startedAt: 5_000 },
    ],
  });
  assert.ok(old);
  assert.match(old.message, /oldest=oldest-task age=5\.0s rss=378MB heap=285MB\/323MB/u);
  assert.doesNotMatch(old.message, /enqueued|completed|failed|autoRefreshSkipped|lastSkipped|top=/u);
});

test("throttles repeats without hiding a continuing anomaly", () => {
  const input = {
    memory,
    pending: [{ label: "oldest", startedAt: 0 }],
  };
  assert.equal(createCodexTranscriptDiagnostic({ ...input, lastLoggedAt: 10_000, now: 14_999 }), null);
  assert.ok(createCodexTranscriptDiagnostic({ ...input, lastLoggedAt: 10_000, now: 15_000 }));
});
