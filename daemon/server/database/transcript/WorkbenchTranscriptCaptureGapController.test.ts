/*
 * No production exports. Tests protect durable shadow gaps, provider recovery selection, and cutover-only failure.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import WorkbenchTranscriptCaptureGapController, {
  type WorkbenchTranscriptCaptureGapMarker,
} from "./WorkbenchTranscriptCaptureGapController.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  WorkbenchThreadId: {
    "canonical": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("canonical"),
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
    "thread-a": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread-a"),
  },
  WorkbenchTurnId: {
    "turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  },
};

test("marker conversion preserves unknown and unrecoverable obligations across aliases and reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-transcript-gap-identity-"));
  const markerPath = join(directory, "gap.json");
  const marker: WorkbenchTranscriptCaptureGapMarker = {
    version: 1, entries: [
      { id: "first", threadId: "native", turnId: "old-turn", recoverability: "provider", openedAt: 1, errorText: "first failure" },
      { id: "second", threadId: "canonical", turnId: "canonical-turn", recoverability: "unrecoverable", openedAt: 2, errorText: "Workbench failure" },
      { id: "unknown", threadId: "unobserved", turnId: null, recoverability: "provider", openedAt: 3, errorText: "unknown failure" },
    ],
  };
  const options = {
    markerPath,
    resolveReference: async (entry: { threadId: string; turnId: string | null }) => entry.threadId === "native"
      ? { threadId: "canonical", turnId: "canonical-turn" } : entry,
  };
  try {
    await writeFile(markerPath, JSON.stringify(marker));
    const controller = new WorkbenchTranscriptCaptureGapController(options);
    await controller.start();
    assert.deepEqual(controller.pendingRecoveryThreadIds, ["unobserved"]);
    assert.equal(controller.hasGap("canonical"), true);
    assert.throws(() => controller.requireRecovery(fixtureIdentityValues.WorkbenchThreadId["canonical"]), /not provider-recoverable/);
    const saved = JSON.parse(await readFile(markerPath, "utf8")) as WorkbenchTranscriptCaptureGapMarker;
    assert.equal(saved.entries.length, 2);
    const converted = saved.entries.find(({ threadId }) => threadId === "canonical")!;
    assert.equal(converted.id, "first");
    assert.equal(converted.turnId, "canonical-turn");
    assert.equal(converted.openedAt, 1);
    assert.deepEqual(saved.entries.find(({ id }) => id === "unknown"), marker.entries[2]);
    const reopened = new WorkbenchTranscriptCaptureGapController(options);
    await reopened.start();
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), saved);
    assert.throws(() => reopened.assertCutoverReady(), /capture gaps/);
  } finally { await rm(directory, { force: true, recursive: true }); }
});

test("capture-gap markers merge threads while only provider gaps enter recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-transcript-gap-"));
  const markerPath = join(directory, "gap.json");
  const ids = ["gap-b", "gap-a"][Symbol.iterator]();
  try {
    const failed = new WorkbenchTranscriptCaptureGapController({
      markerPath,
      now: () => 100,
      randomId: () => ids.next().value!,
    });
    await failed.start();
    await failed.captureFailure({
      error: new Error("write failed"),
      recoverability: "provider",
      threadId: "thread-b",
      turnId: "turn-b",
    });
    await failed.captureFailure({
      error: new Error("another write failed"),
      recoverability: "provider",
      threadId: "thread-a",
      turnId: "turn-a",
    });
    await failed.captureFailure({
      error: new Error("later turn failed"),
      recoverability: "provider",
      threadId: "thread-a",
      turnId: "turn-a-2",
    });
    await failed.captureFailure({
      error: new Error("missed Workbench fact"),
      recoverability: "unrecoverable",
      threadId: "thread-b",
      turnId: "turn-b",
    });

    assert.throws(() => failed.assertCutoverReady(), /capture gaps for 2 thread/u);
    assert.equal(failed.hasGap("thread-a"), true);
    assert.equal(failed.hasGap("other"), false);
    assert.deepEqual(failed.pendingRecoveryThreadIds, ["thread-a"]);

    const marker = JSON.parse(
      await readFile(markerPath, "utf8"),
    ) as WorkbenchTranscriptCaptureGapMarker;
    assert.deepEqual(marker.entries.map(({ threadId }) => threadId), ["thread-a", "thread-b"]);
    assert.equal(marker.entries[0]?.turnId, null);
    assert.equal(marker.entries[0]?.recoverability, "provider");
    assert.equal(marker.entries[1]?.recoverability, "unrecoverable");

    const replacement = new WorkbenchTranscriptCaptureGapController({ markerPath });
    await replacement.start();
    assert.deepEqual(replacement.pendingRecoveryThreadIds, ["thread-a"]);
    const recovery = replacement.requireRecovery(fixtureIdentityValues.WorkbenchThreadId["thread-a"]);
    await replacement.completeRecovery(recovery);
    assert.deepEqual(replacement.pendingRecoveryThreadIds, []);
    assert.throws(() => replacement.assertCutoverReady(), /capture gaps for 1 thread/u);
    assert.equal(replacement.hasGap("thread-b"), true);
    await assert.rejects(
      replacement.completeRecovery(marker.entries[1]!),
      /not provider-recoverable|changed before completion/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the final provider recovery removes the marker and opens cutover readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-transcript-gap-recovered-"));
  const markerPath = join(directory, "gap.json");
  try {
    const controller = new WorkbenchTranscriptCaptureGapController({
      markerPath,
      now: () => 100,
      randomId: () => "gap",
    });
    await controller.start();
    await controller.captureFailure({
      error: new Error("write failed"),
      recoverability: "provider",
      threadId: "thread",
      turnId: "turn",
    });
    const entry = controller.requireRecovery(fixtureIdentityValues.WorkbenchThreadId["thread"]);
    assert.equal(controller.createRecoveryObservation(entry, fixtureIdentityValues.WorkbenchTurnId["turn"]).state, "reconciled");
    await controller.completeRecovery(entry);
    controller.assertCutoverReady();
    await assert.rejects(access(markerPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("an invalid marker blocks cutover without blocking startup or being overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-transcript-gap-invalid-"));
  const markerPath = join(directory, "gap.json");
  try {
    await writeFile(markerPath, "{}\n", "utf8");
    const controller = new WorkbenchTranscriptCaptureGapController({ markerPath });
    await controller.start();
    assert.deepEqual(controller.pendingRecoveryThreadIds, []);
    assert.throws(() => controller.assertCutoverReady(), /invalid shape/u);
    assert.equal(controller.hasGap("any-thread"), true);
    const failure = await controller.captureFailure({
      error: new Error("later SQLite failure"),
      recoverability: "provider",
      threadId: "thread",
      turnId: "turn",
    });
    assert.match(failure.message, /marker is unavailable/u);
    assert.equal(await readFile(markerPath, "utf8"), "{}\n");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
