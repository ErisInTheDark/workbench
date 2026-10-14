/* No production exports. Protect durable turn-anchored gaps, cause-chain evidence, recovery selection and atomic settlement. */
import assert from "node:assert/strict";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { join } from "node:path";
import { test } from "node:test";
import { NativeThreadIdSchema, NativeTurnIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { selectRows } from "workbench-shared/database/workbench-database-statements";
import { evidenceTables } from "workbench-shared/workbench/database/schema/evidence-schema";
import WorkbenchDatabaseController from "../WorkbenchDatabaseController.ts";
import WorkbenchTranscriptCaptureGapController from "./WorkbenchTranscriptCaptureGapController.ts";

test("gaps anchor to turns, survive reopen, keep their cause chain and close only through re-read anchors", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-transcript-gaps-");
  const options = { databasePath: join(temporary.path, "workbench.sqlite3") };
  let database = new WorkbenchDatabaseController(options);
  const threadId = WorkbenchThreadIdSchema.parse("thread");
  const turnId = WorkbenchTurnIdSchema.parse("turn");
  try {
    await database.settleTranscript([{
      kind: "thread", threadId, projectId: testProjectIds.project,
      projectRoot: "/project", title: "retained", createdAt: 1, updatedAt: 1, activityAt: 1,
    }]);
    let gaps = new WorkbenchTranscriptCaptureGapController({ database });
    const capture = (error: unknown = new Error("failed write")) => gaps.captureFailure({ threadId, turnIds: [], recoverability: "provider", error });

    await capture();
    assert.deepEqual(await gaps.pendingRecoveryThreadIds, [], "a thread without turns has nothing to re-read");
    assert.deepEqual((await database.query(selectRows(evidenceTables.transcriptCaptureGaps))).map(row => row.state), ["unrecoverable"]);

    await database.settleTranscript([{
      kind: "turn", threadId, turnId, turnIndex: 0, harnessId: "codex", nativeLocation: "/project",
      nativeThreadId: NativeThreadIdSchema.parse("native-thread"), nativeTurnId: NativeTurnIdSchema.parse("native-turn"),
      state: "completed", createdAt: 2, startedAt: 2, endedAt: 3, durationMs: 1,
    }]);
    await capture(new AggregateError([new Error("Reloadable owner database unavailable")], "Branch replacement failed during rollback."));
    await database.close();
    database = new WorkbenchDatabaseController(options);
    gaps = new WorkbenchTranscriptCaptureGapController({ database });
    assert.deepEqual(await gaps.pendingRecoveryThreadIds, [threadId]);
    const [observed] = await gaps.readRecovery(threadId);
    assert.deepEqual(observed?.turnIds, [turnId], "a turnless failure anchors the latest turn");
    assert.match(observed!.errorText, /Branch replacement failed during rollback\..*Reloadable owner database unavailable/u);

    await capture();
    await database.settleTranscript([gaps.createRecoveryObservation(observed!, [WorkbenchTurnIdSchema.parse("other-turn")])]);
    assert.equal((await gaps.readRecovery(threadId)).length, 2, "re-reading an unrelated turn reconciles nothing");
    const closure = (await gaps.readRecovery(threadId)).map(entry => gaps.createRecoveryObservation(entry, entry.turnIds));
    await assert.rejects(database.settleTranscript([
      ...closure,
      { ...closure[0]!, gapId: "missing", threadId: WorkbenchThreadIdSchema.parse("unadmitted") },
    ]));
    assert.deepEqual(await gaps.pendingRecoveryThreadIds, [threadId], "a failed settlement closes nothing");
    await database.settleTranscript(closure);
    assert.deepEqual(await gaps.pendingRecoveryThreadIds, []);
    assert.deepEqual(await gaps.readRecovery(threadId), []);
  } finally {
    await database.close();
    await temporary.dispose();
  }
});
