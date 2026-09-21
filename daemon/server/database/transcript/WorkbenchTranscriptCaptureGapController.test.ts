/* No production exports. Protect durable gap ownership, recovery isolation and atomic settlement. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { selectRows } from "workbench-shared/database/workbench-database-statements";
import { evidenceTables } from "workbench-shared/workbench/database/schema/evidence-schema";
import WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import WorkbenchTranscriptCaptureGapController from "./WorkbenchTranscriptCaptureGapController.ts";

test("a missing Workbench fact does not prevent selecting unrelated provider gaps", async () => {
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const database = {
    query: async () => [
      { id: "provider-gap", thread_id: threadId, turn_id: "provider-turn", state: "open", opened_at: 1, error_text: "missed provider item" },
      { id: "local-gap", thread_id: threadId, turn_id: "local-turn", state: "unrecoverable", opened_at: 2, error_text: "missed local item" },
    ],
  } as unknown as WorkbenchDatabaseController;
  const gaps = new WorkbenchTranscriptCaptureGapController({ database });
  assert.deepEqual((await gaps.requireRecovery(threadId)).map(gap => gap.id), ["provider-gap"]);
});

test("gaps survive reopen and reconciliation closes only its observed failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-transcript-gaps-"));
  const options = { databasePath: join(directory, "workbench.sqlite3") };
  let database = new WorkbenchDatabaseController(options);
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  try {
    await database.settleTranscript([{
      kind: "thread", threadId, projectId: testProjectIds.project,
      projectRoot: "/project", title: "retained", createdAt: 1, updatedAt: 1, activityAt: 1,
    }]);
    let gaps = new WorkbenchTranscriptCaptureGapController({ database });
    const capture = () => gaps.captureFailure({ threadId, turnId: null, recoverability: "provider", error: new Error("failed write") });
    await capture();
    await database.close();
    database = new WorkbenchDatabaseController(options);
    gaps = new WorkbenchTranscriptCaptureGapController({ database });
    assert.deepEqual(await gaps.pendingRecoveryThreadIds, [threadId]);
    const observed = await gaps.requireRecovery(threadId);
    await capture();
    await database.settleTranscript(observed.map(entry => gaps.createRecoveryObservation(entry, null)));
    assert.deepEqual(await gaps.pendingRecoveryThreadIds, [threadId]);
    const remaining = await gaps.requireRecovery(threadId);
    assert.equal(remaining.length, 1);
    const closure = remaining.map(entry => gaps.createRecoveryObservation(entry, null));
    await assert.rejects(database.settleTranscript([
      ...closure,
      { ...closure[0]!, gapId: "missing", threadId: WorkbenchThreadIdSchema.parse("unadmitted") },
    ]));
    assert.deepEqual(await gaps.pendingRecoveryThreadIds, [threadId]);
    await database.settleTranscript(closure);
    assert.deepEqual(await gaps.pendingRecoveryThreadIds, []);
    assert.deepEqual((await database.query(selectRows(evidenceTables.transcriptCaptureGaps))).map(row => row.state), ["reconciled", "reconciled"]);
    await capture();
    const beforeLocalFailure = await gaps.requireRecovery(threadId);
    await gaps.captureFailure({ threadId, turnId: null, recoverability: "unrecoverable", error: new Error("missed local fact") });
    await database.settleTranscript(beforeLocalFailure.map(entry => gaps.createRecoveryObservation(entry, null)));
    assert.deepEqual(await gaps.pendingRecoveryThreadIds, []);
    assert.equal((await database.query(selectRows(evidenceTables.transcriptCaptureGaps, { where: { state: "unrecoverable" } }))).length, 1);
    await assert.rejects(gaps.requireRecovery(threadId), /no entry/);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
