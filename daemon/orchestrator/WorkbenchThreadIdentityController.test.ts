/*
 * Keywords: thread identity, live lookup, database reload, disposal.
 * No exports. Tests protect synchronous admitted identity and reject stale lifecycle results.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  WorkbenchThreadIdentityDatabase,
  WorkbenchThreadIdentityRecord,
} from "./database/thread-identity/workbench-thread-identity-types";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";

const record: WorkbenchThreadIdentityRecord = {
  threadId: "workbench-owned",
  projectId: "project",
  projectRoot: "C:/project",
  bindings: [{
    harness: "codex", nativeThreadId: "provider-owned", nativeLocation: "C:/project",
    pending: true, turnIndex: null,
  }],
};

function database(overrides: Partial<WorkbenchThreadIdentityDatabase> = {}): WorkbenchThreadIdentityDatabase {
  return {
    observeThreadIdentities: async () => [record],
    resolveThreadIdentity: async () => { throw new Error("Unexpected public lookup during live projection."); },
    resolveNativeThreadIdentity: async () => { throw new Error("Unexpected native lookup during live projection."); },
    listThreadIdentities: async () => [record],
    observeTurnIdentities: async () => { throw new Error("Unexpected turn admission."); },
    resolveTurnIdentity: async () => { throw new Error("Unexpected turn lookup."); },
    ...overrides,
  };
}

test("live identity projection uses committed bindings after admission and database reload", async () => {
  const initial = new WorkbenchThreadIdentityController(database({ listThreadIdentities: async () => [] }));
  const native = record.bindings[0]!;
  await initial.start();
  await initial.observe({
    native, projectId: record.projectId, projectRoot: record.projectRoot,
    title: "Thread", createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  assert.equal(initial.workbenchIdForNative(native), record.threadId);
  assert.equal((await initial.resolve({ threadId: record.threadId }))?.threadId, record.threadId);
  initial.dispose();
  const replacement = new WorkbenchThreadIdentityController(database());
  await replacement.start();
  assert.equal(replacement.workbenchIdForNative(native), record.threadId);
  assert.throws(() => replacement.workbenchIdForNative({ ...native, nativeLocation: "C:/another-project" }), /not been admitted/);
  replacement.dispose();
});

test("an identity result arriving after disposal cannot repopulate live lookup", async () => {
  let completeAdmission!: (record: WorkbenchThreadIdentityRecord) => void;
  const admission = new Promise<WorkbenchThreadIdentityRecord>((resolve) => { completeAdmission = resolve; });
  const controller = new WorkbenchThreadIdentityController(database({
    observeThreadIdentities: async () => [await admission],
  }));
  await controller.start();
  const observing = controller.observe({
    native: record.bindings[0]!, projectId: record.projectId, projectRoot: record.projectRoot,
    title: "Thread", createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  controller.dispose();
  completeAdmission(record);
  await assert.rejects(observing, /disposed/);
  assert.throws(() => controller.knownThread(record.threadId), /disposed/);
});

test("committed turn admission supplies native delta lookup and advances the pending thread binding", async () => {
  let admitted = 0;
  const native = record.bindings[0]!;
  const turn = {
    threadId: record.threadId, turnId: "workbench-turn", turnIndex: 0,
    native: { ...native, nativeTurnId: "native-turn" },
  };
  const controller = new WorkbenchThreadIdentityController(database({
    observeTurnIdentities: async () => {
      admitted += 1;
      return [turn];
    },
  }));
  await controller.start();
  await controller.observeTurn({
    kind: "turn", threadId: record.threadId, turnId: "native-turn",
    harnessId: native.harness, nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId,
    nativeTurnId: "native-turn", state: "inProgress", createdAt: 2, startedAt: 2, endedAt: null, durationMs: null,
  });
  assert.equal(controller.workbenchTurnIdForNative(turn.native), turn.turnId);
  assert.equal(controller.knownTurn(turn.turnId).threadId, record.threadId);
  assert.equal(controller.knownThread(record.threadId).bindings[0]?.pending, false);
  assert.equal(admitted, 1);
  assert.throws(() => controller.workbenchTurnIdForNative({ ...turn.native, nativeThreadId: "another" }), /not been admitted/iu);
  controller.dispose();
  assert.throws(() => controller.knownTurn(turn.turnId), /disposed/iu);
});

test("Windows native path aliases resolve together after cold start without changing stored paths", async () => {
  const locations = ["C:\\Project", "c:/project", "\\\\?\\C:\\PROJECT"];
  const retained = {
    ...record,
    bindings: locations.map((nativeLocation) => ({ ...record.bindings[0]!, nativeLocation })),
  };
  const controller = new WorkbenchThreadIdentityController(database({
    listThreadIdentities: async () => [retained],
  }), "win32");
  await controller.start();
  try {
    assert.ok(locations.includes(controller.knownNativeBinding("codex", "provider-owned").nativeLocation));
    for (const nativeLocation of locations) {
      assert.equal(controller.workbenchIdForNative({ ...record.bindings[0]!, nativeLocation }), record.threadId);
    }
    assert.deepEqual(controller.knownThread(record.threadId).bindings, retained.bindings);
  } finally { controller.dispose(); }
});

test("Linux case-distinct native locations remain separate owners", async () => {
  const first = { ...record, bindings: [{ ...record.bindings[0]!, nativeLocation: "/repo/Project" }] };
  const second = { ...record, threadId: "another-owner", bindings: [{ ...record.bindings[0]!, nativeLocation: "/repo/project" }] };
  const controller = new WorkbenchThreadIdentityController(database({
    listThreadIdentities: async () => [first, second],
  }), "linux");
  await controller.start();
  try {
    assert.equal(controller.workbenchIdForNative(first.bindings[0]!), first.threadId);
    assert.equal(controller.workbenchIdForNative(second.bindings[0]!), second.threadId);
    assert.throws(() => controller.knownNativeBinding("codex", "provider-owned"), /requires a location/);
  } finally { controller.dispose(); }
});

test("Windows path equivalence does not hide competing Workbench owners", async () => {
  const controller = new WorkbenchThreadIdentityController(database({
    listThreadIdentities: async () => [
      { ...record, bindings: [{ ...record.bindings[0]!, nativeLocation: "C:\\Project" }] },
      { ...record, threadId: "other", bindings: [{ ...record.bindings[0]!, nativeLocation: "c:/project" }] },
    ],
  }), "win32");
  try {
    await assert.rejects(controller.start(), /conflicting Workbench owners/);
  } finally { controller.dispose(); }
});
