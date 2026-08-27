/*
 * Regression wards for serialized transcript-shadow writes, disposal flush, and one-shot failure reporting.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import WorkbenchTranscriptShadowLog from "./WorkbenchTranscriptShadowLog.ts";

test("shadow log flush preserves queued record order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-shadow-log-"));
  const filePath = join(directory, "nested", "shadow.jsonl");
  try {
    const failures: Error[] = [];
    const log = new WorkbenchTranscriptShadowLog(filePath, (error) => failures.push(error));
    await log.start();
    log.write({ event: "first", level: "info", source: "test" });
    log.write({ event: "second", level: "warning", source: "test" });
    await log.flush();

    const records = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string });
    assert.deepEqual(records.map(({ event }) => event), ["first", "second"]);
    assert.deepEqual(failures, []);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("shadow log reports one bounded failure for a broken destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-shadow-log-failure-"));
  try {
    const failures: Error[] = [];
    const log = new WorkbenchTranscriptShadowLog(directory, (error) => failures.push(error));
    log.write({ event: "first", level: "info", source: "test" });
    log.write({ event: "second", level: "info", source: "test" });
    await log.flush();
    assert.equal(failures.length, 1);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
