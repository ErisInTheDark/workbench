/* Exports: none. Protect active-turn directive idempotence and held-steer replacement ordering. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchThreadAdmissionController from "./WorkbenchThreadAdmissionController";
import WorkbenchThreadContextRolloverController from "./WorkbenchThreadContextRolloverController";

const threadId = WorkbenchThreadIdSchema.parse("thread");
const turnId = WorkbenchTurnIdSchema.parse("turn");

function fixture() {
  const admission = new WorkbenchThreadAdmissionController();
  const directives: string[] = [];
  const observations: string[] = [];
  const replacements: string[] = [];
  let replace = async (summary: string) => { replacements.push(summary); };
  const owner = new WorkbenchThreadContextRolloverController(admission, {
    readSelectedCap: async () => 100_000,
    requestDirective: async (_threadId, _turnId, instruction) => { directives.push(instruction); },
    record: async observation => { observations.push(observation.phase); },
    replace: async input => { await replace(input.summary); },
    now: () => 10,
    warn: () => {},
  });
  return {
    admission,
    directives,
    observations,
    owner,
    replacements,
    replace: (next: typeof replace) => { replace = next; },
  };
}

test("threshold evidence requests one active-turn directive", async () => {
  const f = fixture();
  await Promise.all([
    f.owner.observeUsage({ contextTokens: 100_000, threadId, turnId }),
    f.owner.observeUsage({ contextTokens: 100_000, threadId, turnId }),
  ]);
  assert.equal(f.directives.length, 1);
  await f.owner.dispose();
  await f.admission.dispose();
});

test("directive admission failure warns and remains retryable", async () => {
  const admission = new WorkbenchThreadAdmissionController();
  const warnings: string[] = [];
  let attempts = 0;
  const owner = new WorkbenchThreadContextRolloverController(admission, {
    readSelectedCap: async () => 100_000,
    requestDirective: async () => {
      attempts += 1;
      throw new Error("instruction unavailable");
    },
    record: async () => {},
    replace: async () => {},
    now: () => 10,
    warn: message => { warnings.push(message); },
  });

  await owner.observeUsage({ contextTokens: 100_000, threadId, turnId });
  await owner.observeUsage({ contextTokens: 100_000, threadId, turnId });

  assert.equal(attempts, 2);
  assert.deepEqual(warnings, [
    "Context rollover directive admission failed: instruction unavailable",
    "Context rollover directive admission failed: instruction unavailable",
  ]);
  await owner.dispose();
  await admission.dispose();
});

test("tool start holds later input until replacement execution is active", async () => {
  const f = fixture();
  const replacing = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  f.replace(async summary => {
    f.replacements.push(summary);
    replacing.resolve();
    await replaced.promise;
  });
  await f.owner.toolStarted({ reference: "compact", threadId, turnId });
  let admitted = false;
  const queued = f.admission.run(threadId, async () => { admitted = true; });
  await f.owner.acceptSummary({ summary: "full summary", threadId, turnId });
  const settlement = f.owner.toolSucceeded({ reference: "compact", threadId, turnId });
  await replacing.promise;
  assert.equal(admitted, false);
  replaced.resolve();
  await settlement;
  await queued;
  assert.equal(admitted, true);
  assert.deepEqual(f.replacements, ["full summary"]);
  assert.deepEqual(f.observations, ["started", "completed"]);
  await f.owner.dispose();
  await f.admission.dispose();
});

test("replacement failure visibly rejects already-held input and leaves later admission usable", async () => {
  const f = fixture();
  f.replace(async () => { throw new Error("replacement failed"); });
  await f.owner.toolStarted({ reference: "compact", threadId, turnId });
  const first = f.admission.run(threadId, async () => assert.fail("held input was admitted"));
  const second = f.admission.run(threadId, async () => assert.fail("held input was admitted"));
  await f.owner.acceptSummary({ summary: "full summary", threadId, turnId });
  await assert.rejects(f.owner.toolSucceeded({ reference: "compact", threadId, turnId }), /replacement failed/);
  await assert.rejects(first, /replacement failed/);
  await assert.rejects(second, /replacement failed/);
  assert.deepEqual(f.observations, ["started", "failed"]);
  assert.equal(await f.admission.run(threadId, async () => "later"), "later");
  await f.owner.dispose();
  await f.admission.dispose();
});

test("summary completion without native tool-input start is rejected", async () => {
  const f = fixture();
  await assert.rejects(
    f.owner.acceptSummary({ summary: "full summary", threadId, turnId }),
    /has not started/,
  );
  await f.owner.dispose();
  await f.admission.dispose();
});
