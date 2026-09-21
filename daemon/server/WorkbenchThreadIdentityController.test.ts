/*
 * No exports. Tests protect synchronous admitted identity and reject stale lifecycle results.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  WorkbenchThreadIdentityDatabase,
  WorkbenchThreadIdentityRecord,
} from "./database/thread-identity/workbench-thread-identity-types";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

const fixtureIdentityValues = {
  NativeThreadId: {
    "another": fixtureIdentitySchemas.NativeThreadIdSchema.parse("another"),
    "provider-owned": fixtureIdentitySchemas.NativeThreadIdSchema.parse("provider-owned"),
  },
  NativeTurnId: {
    "native-turn": fixtureIdentitySchemas.NativeTurnIdSchema.parse("native-turn"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "workbench-owned": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("workbench-owned"),
  },
};

const record: WorkbenchThreadIdentityRecord = {
  threadId: fixtureIdentityValues.WorkbenchThreadId["workbench-owned"],
  projectId: fixtureIdentityValues.ProjectId["project"],
  projectRoot: "C:/project",
  bindings: [{
    harness: "codex", nativeThreadId: fixtureIdentityValues.NativeThreadId["provider-owned"], nativeLocation: "C:/project",
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

test("cached thread ownership delegates retained project aliases to the database owner", async () => {
  const canonical = { ...record, projectId: testProjectIds.repo };
  const controller = new WorkbenchThreadIdentityController(database({
    listThreadIdentities: async () => [canonical],
    resolveThreadIdentity: async input => {
      if (input.projectId !== record.projectId) throw new Error("Workbench thread does not belong to the requested project.");
      return canonical;
    },
  }));
  try {
    await controller.start();
    assert.equal((await controller.resolve({ threadId: canonical.threadId, projectId: record.projectId }))?.projectId, canonical.projectId);
    await assert.rejects(controller.resolve({
      threadId: canonical.threadId, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("foreign"),
    }), /requested project/);
  } finally { controller.dispose(); }
});

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
    threadId: record.threadId, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("workbench-turn"), turnIndex: 0,
    native: { ...native, nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse("native-turn") },
  };
  const controller = new WorkbenchThreadIdentityController(database({
    observeTurnIdentities: async () => {
      admitted += 1;
      return [turn];
    },
  }));
  await controller.start();
  await controller.observeTurn({
    kind: "turn", threadId: record.threadId, turnId: fixtureIdentityValues.NativeTurnId["native-turn"],
    harnessId: native.harness, nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId,
    nativeTurnId: fixtureIdentityValues.NativeTurnId["native-turn"], state: "inProgress", createdAt: 2, startedAt: 2, endedAt: null, durationMs: null,
  });
  assert.equal(controller.workbenchTurnIdForNative(turn.native), turn.turnId);
  assert.equal(controller.knownTurn(fixtureIdentitySchemas.TurnReferenceSchema.parse(turn.turnId)).threadId, record.threadId);
  assert.equal(controller.knownThread(record.threadId).bindings[0]?.pending, false);
  assert.equal(admitted, 1);
  assert.throws(() => controller.workbenchTurnIdForNative({ ...turn.native, nativeThreadId: fixtureIdentityValues.NativeThreadId["another"] }), /not been admitted/iu);
  controller.dispose();
  assert.throws(() => controller.knownTurn(fixtureIdentitySchemas.TurnReferenceSchema.parse(turn.turnId)), /disposed/iu);
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
    assert.ok(locations.includes(controller.knownNativeBinding("codex", fixtureIdentityValues.NativeThreadId["provider-owned"]).nativeLocation));
    for (const nativeLocation of locations) {
      assert.equal(controller.workbenchIdForNative({ ...record.bindings[0]!, nativeLocation }), record.threadId);
    }
    assert.deepEqual(controller.knownThread(record.threadId).bindings, retained.bindings);
  } finally { controller.dispose(); }
});

test("Git arc target ownership derives the target harness from its repository binding", async () => {
  const target = {
    ...record,
    threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("target"),
    bindings: ["C:/project", "c:\\PROJECT"].map(nativeLocation => ({
      ...record.bindings[0]!,
      harness: "opencode",
      nativeLocation,
      nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("target-native"),
    })),
  };
  const controller = new WorkbenchThreadIdentityController(database({
    listThreadIdentities: async () => [target],
  }), "win32");
  await controller.start();
  try {
    assert.deepEqual(await controller.resolveGitArcThreadOwner({
      projectId: target.projectId,
      repositoryRoot: target.projectRoot,
      threadId: target.threadId,
    }), {
      harness: "opencode",
      nativeThreadId: target.bindings[0]!.nativeThreadId,
      threadId: target.threadId,
    });
  } finally { controller.dispose(); }
});

test("Git arc target ownership rejects ambiguous repository bindings", async () => {
  const ambiguous = {
    ...record,
    bindings: [
      record.bindings[0]!,
      {
        ...record.bindings[0]!,
        harness: "opencode",
        nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("other-native"),
      },
    ],
  };
  const controller = new WorkbenchThreadIdentityController(database({
    listThreadIdentities: async () => [ambiguous],
  }));
  await controller.start();
  try {
    await assert.rejects(controller.resolveGitArcThreadOwner({
      projectId: ambiguous.projectId,
      repositoryRoot: ambiguous.projectRoot,
      threadId: ambiguous.threadId,
    }), /multiple Git arc bindings/iu);
  } finally { controller.dispose(); }
});

test("Linux case-distinct native locations remain separate owners", async () => {
  const first = { ...record, bindings: [{ ...record.bindings[0]!, nativeLocation: "/repo/Project" }] };
  const second = { ...record, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("another-owner"), bindings: [{ ...record.bindings[0]!, nativeLocation: "/repo/project" }] };
  const controller = new WorkbenchThreadIdentityController(database({
    listThreadIdentities: async () => [first, second],
  }), "linux");
  await controller.start();
  try {
    assert.equal(controller.workbenchIdForNative(first.bindings[0]!), first.threadId);
    assert.equal(controller.workbenchIdForNative(second.bindings[0]!), second.threadId);
    assert.throws(() => controller.knownNativeBinding("codex", fixtureIdentityValues.NativeThreadId["provider-owned"]), /requires a location/);
  } finally { controller.dispose(); }
});

test("Windows path equivalence does not hide competing Workbench owners", async () => {
  const controller = new WorkbenchThreadIdentityController(database({
    listThreadIdentities: async () => [
      { ...record, bindings: [{ ...record.bindings[0]!, nativeLocation: "C:\\Project" }] },
      { ...record, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("other"), bindings: [{ ...record.bindings[0]!, nativeLocation: "c:/project" }] },
    ],
  }), "win32");
  try {
    await assert.rejects(controller.start(), /conflicting Workbench owners/);
  } finally { controller.dispose(); }
});
