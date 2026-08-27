/*
 * Regression wards for token-minimal transcript-shadow formatting, pre-output filtering, grouping, and malformed-line retention.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  formatAgentValue,
  readTranscriptShadowReport,
} from "./report-transcript-shadow-logs.mjs";

test("agent formatting uses scalar lists and homogeneous object tables", () => {
  assert.deepEqual(formatAgentValue({
    requested: ["turn-3", "turn-4"],
    context: [
      { id: "item-7", index: 42, kind: "operation" },
      { id: "item-8", index: 43, kind: "reasoning" },
    ],
  }), [
    "requested turn-3 turn-4",
    "context",
    "  id\tindex\tkind",
    "  item-7\t42\toperation",
    "  item-8\t43\treasoning",
  ]);
});

test("report defaults to failures, groups equal records across the range, and retains malformed lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-shadow-report-"));
  const filePath = join(directory, "shadow.jsonl");
  try {
    await writeFile(filePath, [
      JSON.stringify({ at: 1, event: "same", level: "warning", source: "test", threadId: "other" }),
      JSON.stringify({ at: 2, event: "same", level: "warning", source: "test", threadId: "thread" }),
      JSON.stringify({ at: 2.5, event: "routine", level: "info", source: "test", threadId: "thread" }),
      JSON.stringify({ at: 3, event: "same", level: "warning", source: "test", threadId: "thread" }),
      "{broken",
      "",
    ].join("\n"), "utf8");

    const groups = await readTranscriptShadowReport(filePath, {
      limit: 10,
      since: 2,
      threadId: "thread",
    });
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.count, 2);
    assert.equal(groups[0]?.firstAt, 2);
    assert.equal(groups[0]?.lastAt, 3);

    const all = await readTranscriptShadowReport(filePath, { limit: 10 });
    assert.equal(all.some(({ record }) => record.event === "routine"), false);
    assert.equal(all.some(({ record }) => record.event === "malformed-line"), true);
    const withRoutine = await readTranscriptShadowReport(filePath, { all: true, limit: 10 });
    assert.equal(withRoutine.some(({ record }) => record.event === "routine"), true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("changing parity evidence groups by mismatch while retaining the latest useful context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-shadow-parity-report-"));
  const filePath = join(directory, "shadow.jsonl");
  try {
    await writeFile(filePath, [
      JSON.stringify({
        at: 1,
        event: "parity-mismatch",
        fields: { jsonContext: [{ id: "old" }], mismatch: "payload", scope: "display" },
        level: "warning",
        source: "workbench-transcript-parity",
        threadId: "thread",
      }),
      JSON.stringify({
        at: 2,
        event: "parity-mismatch",
        fields: { jsonContext: [{ id: "latest" }], mismatch: "payload", scope: "display" },
        level: "warning",
        source: "workbench-transcript-parity",
        threadId: "thread",
      }),
    ].join("\n"), "utf8");

    const groups = await readTranscriptShadowReport(filePath, { limit: 10 });
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.count, 2);
    assert.equal(groups[0]?.lastAt, 2);
    assert.deepEqual(groups[0]?.record.fields.jsonContext, [{ id: "latest" }]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
