/*
 * Keywords: thread identity, fresh UUID, legacy relink, lookup precedence.
 * No exports. Tests protect durable identity independently of native ids and transcript bodies.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository.ts";
import WorkbenchThreadIdentityRepository from "./WorkbenchThreadIdentityRepository.ts";
import type { WorkbenchThreadIdentityMetadata, WorkbenchTurnIdentityMetadata } from "./workbench-thread-identity-types.ts";

function metadata(nativeThreadId = "native-thread", nativeLocation = "C:/project"): WorkbenchThreadIdentityMetadata {
  return {
    native: { harness: "codex", nativeLocation, nativeThreadId },
    projectId: "project",
    projectRoot: "C:/project",
    title: "Existing thread",
    activityAt: 20,
    createdAt: 1,
    updatedAt: 20,
  };
}

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return { database, identity: new WorkbenchThreadIdentityRepository(database) };
}

test("a converted metadata-only row keeps its identity when native metadata arrives", () => {
  const { database, identity } = setup();
  try {
    const input = metadata();
    new WorkbenchTranscriptRepository(database).settle([{ kind: "thread", threadId: input.native.nativeThreadId, ...input }]);
    const converted = identity.resolve({ threadId: input.native.nativeThreadId });
    assert.ok(converted);
    assert.deepEqual(converted.bindings, []);
    const observed = identity.observe(input);
    assert.equal(observed.threadId, converted.threadId);
    assert.equal(identity.resolveNative(input.native)?.threadId, converted.threadId);
    assert.equal(identity.list().length, 1);
    assert.equal(observed.bindings[0]?.nativeThreadId, input.native.nativeThreadId);
  } finally { database.close(); }
});

test("historical catalog inserts missing turns before known successors without moving existing history", () => {
  const { database, identity } = setup();
  try {
    const input = metadata();
    const thread = identity.observe(input);
    const turn = (nativeTurnId: string): WorkbenchTurnIdentityMetadata => ({
      kind: "turn", threadId: thread.threadId, turnId: nativeTurnId, nativeTurnId,
      harnessId: input.native.harness, nativeLocation: input.native.nativeLocation,
      nativeThreadId: input.native.nativeThreadId, state: "completed",
      createdAt: 2, startedAt: 2, endedAt: 3, durationMs: 1,
    });
    const newest = identity.observeTurn(turn("newest"));
    const later = identity.observeTurn(turn("later"));
    const catalog = [turn("oldest"), turn("middle"), turn("newest")];
    const observed = identity.observeTurns(catalog);
    const order = () => database.prepare("SELECT native_turn_id FROM thread_turns ORDER BY turn_index").all();
    assert.deepEqual(order(), ["oldest", "middle", "newest", "later"].map((native_turn_id) => ({ native_turn_id })));
    assert.equal(identity.resolveTurn({ threadId: thread.threadId, turnId: newest.turnId })?.turnIndex, 2);
    assert.equal(observed.find((record) => record.turnId === later.turnId)?.turnIndex, 3);
    identity.observeTurns(catalog);
    identity.observeTurns([turn("later"), turn("newest")]);
    assert.deepEqual(order(), ["oldest", "middle", "newest", "later"].map((native_turn_id) => ({ native_turn_id })));
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("thread catalog admission rolls back earlier metadata and allocations on a later owner conflict", () => {
  const { database, identity } = setup();
  try {
    const existing = identity.observe(metadata("existing"));
    const catalog = [
      { ...metadata("existing"), title: "Changed", updatedAt: 30 },
      metadata("new"),
      { ...metadata("existing"), projectId: "other" },
    ];
    assert.throws(() => identity.observeMany(catalog), /project owner/iu);
    assert.equal(identity.resolveNative(metadata("new").native), null);
    assert.deepEqual(database.prepare("SELECT title FROM workbench_threads WHERE id = ?").get(existing.threadId),
      { title: "Existing thread" });
    const committed = identity.observeMany(catalog.slice(0, 2));
    assert.equal(committed[0]!.threadId, existing.threadId);
    assert.deepEqual(identity.observeMany(catalog.slice(0, 2)), committed);
    assert.deepEqual(database.prepare("SELECT id FROM thread_turns").all(), []);
  } finally {
    database.close();
  }
});

test("turn catalog identity admission rolls back every new identity on ownership conflict", () => {
  const { database, identity } = setup();
  try {
    const input = metadata();
    const thread = identity.observe(input);
    const turn = (nativeTurnId: string): WorkbenchTurnIdentityMetadata => ({
      kind: "turn", threadId: thread.threadId, turnId: nativeTurnId, nativeTurnId,
      harnessId: input.native.harness, nativeLocation: input.native.nativeLocation,
      nativeThreadId: input.native.nativeThreadId, state: "completed",
      createdAt: 2, startedAt: 2, endedAt: 3, durationMs: 1,
    });
    assert.throws(() => identity.observeTurns([
      turn("first"), { ...turn("second"), nativeThreadId: "foreign-thread" },
    ]), /owner/iu);
    assert.deepEqual(database.prepare("SELECT id FROM thread_turns").all(), []);
    assert.deepEqual(identity.resolve({ threadId: thread.threadId }), thread);
    const admitted = identity.observeTurns([turn("first"), turn("second")]);
    assert.deepEqual(identity.observeTurns([turn("first"), turn("second")]), admitted);
    assert.notEqual(admitted[0]!.turnId, admitted[1]!.turnId);
    assert.deepEqual(admitted.map(({ turnIndex }) => turnIndex), [0, 1]);
    assert.deepEqual(database.prepare("SELECT turn_id FROM thread_turn_materializations").all(), []);
  } finally {
    database.close();
  }
});

test("thread identity allocates independently of native identity without loading any turns", () => {
  const { database, identity } = setup();
  try {
    const input = metadata();
    const first = identity.observe(input);
    assert.notEqual(first.threadId, input.native.nativeThreadId);
    assert.deepEqual(identity.observe(input), first);
    assert.deepEqual(new WorkbenchThreadIdentityRepository(database).resolveNative(input.native), first);
    assert.equal((database.prepare("SELECT count(*) AS count FROM thread_turns").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT count(*) AS count FROM thread_turn_materializations").get() as { count: number }).count, 0);
    assert.deepEqual(identity.resolve({ threadId: first.threadId }), first);
    assert.deepEqual(identity.resolve({ threadId: input.native.nativeThreadId }), first);
  } finally {
    database.close();
  }
});

test("thread identity relinks an existing transcript without changing its items or native ownership", () => {
  const { database, identity } = setup();
  try {
    const transcript = new WorkbenchTranscriptRepository(database);
    const input = metadata();
    const threadId = input.native.nativeThreadId;
    transcript.settle([
      { kind: "thread", threadId, ...input },
      {
        kind: "turn", threadId, turnId: "existing-turn", harnessId: "codex",
        nativeLocation: input.native.nativeLocation, nativeThreadId: threadId, nativeTurnId: "existing-turn",
        state: "completed", createdAt: 2, startedAt: 2, endedAt: 10, durationMs: 8,
      },
      {
        kind: "item", threadId, turnId: "existing-turn", lifecycle: "completed", observedAt: 5,
        item: {
          id: "existing-item", type: "agentMessage", text: "Keep this history",
          phase: "commentary", memoryCitation: null, delivery: null, questions: null,
        },
      },
    ]);
    const before = database.prepare("SELECT * FROM thread_items").all() as Array<Record<string, string | number | null>>;
    const resolved = identity.resolve({ threadId });
    assert.ok(resolved);
    assert.notEqual(resolved.threadId, threadId);
    assert.deepEqual(database.prepare("SELECT * FROM thread_items").all(),
      before.map((row) => ({ ...row, thread_id: resolved.threadId })));
    assert.deepEqual(database.prepare("SELECT thread_id, native_thread_id FROM thread_turns").all(),
      [{ thread_id: resolved.threadId, native_thread_id: threadId }]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(identity.observe(input), resolved);
    assert.equal((database.prepare("SELECT count(*) AS count FROM workbench_threads").get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
});

test("public thread lookup prefers WB ownership while trusted-native lookup never does", () => {
  const { database, identity } = setup();
  try {
    const first = identity.observe(metadata("first-native"));
    const secondInput = metadata(first.threadId, "C:/project/second");
    const second = identity.observe(secondInput);
    assert.notEqual(second.threadId, first.threadId);
    assert.equal(identity.resolve({ threadId: first.threadId })?.threadId, first.threadId);
    assert.equal(identity.resolveNative(secondInput.native)?.threadId, second.threadId);
  } finally {
    database.close();
  }
});

test("native-id fallback rejects ambiguity rather than selecting another location's thread", () => {
  const { database, identity } = setup();
  try {
    const firstInput = metadata("shared-native", "C:/project/one");
    const secondInput = metadata("shared-native", "C:/project/two");
    const first = identity.observe(firstInput);
    const second = identity.observe(secondInput);
    assert.notEqual(first.threadId, second.threadId);
    assert.throws(() => identity.resolve({ threadId: "shared-native" }), /ambiguous/);
    assert.equal(identity.resolveNative(firstInput.native)?.threadId, first.threadId);
    assert.equal(identity.resolveNative(secondInput.native)?.threadId, second.threadId);
  } finally {
    database.close();
  }
});

test("a legacy primary key must not outrank an ambiguous native-id fallback", () => {
  const { database, identity } = setup();
  try {
    const input = metadata("legacy-native");
    new WorkbenchTranscriptRepository(database).settle([
      { kind: "thread", threadId: input.native.nativeThreadId, ...input },
      {
        kind: "turn", threadId: input.native.nativeThreadId, turnId: "legacy-turn", harnessId: "codex",
        nativeLocation: input.native.nativeLocation, nativeThreadId: input.native.nativeThreadId,
        nativeTurnId: "legacy-turn", state: "completed", createdAt: 2, startedAt: 2, endedAt: 3, durationMs: 1,
      },
    ]);
    identity.observe(metadata(input.native.nativeThreadId, "C:/project/other"));
    assert.throws(() => identity.resolve({ threadId: input.native.nativeThreadId }), /ambiguous/);
  } finally {
    database.close();
  }
});

test("recording a durable turn transfers identity out of the pending row", () => {
  const { database, identity } = setup();
  try {
    const input = metadata();
    const { threadId } = identity.observe(input);
    new WorkbenchTranscriptRepository(database).settle([{
      kind: "turn", threadId, turnId: "known-turn", harnessId: "codex",
      nativeLocation: input.native.nativeLocation, nativeThreadId: input.native.nativeThreadId,
      nativeTurnId: "known-turn", state: "completed", createdAt: 2, startedAt: 2, endedAt: 3, durationMs: 1,
    }]);
    const resolved = new WorkbenchThreadIdentityRepository(database).resolveNative(input.native);
    assert.equal(resolved?.threadId, threadId);
    assert.equal((database.prepare("SELECT count(*) AS count FROM workbench_pending_import_threads").get() as { count: number }).count, 0);
    assert.equal(resolved?.bindings.length, 1);
    assert.equal(resolved?.bindings[0]?.pending, false);
  } finally {
    database.close();
  }
});

test("an encoded former Workbench key remains a private alias after relinking", () => {
  const { database, identity } = setup();
  try {
    const input = metadata();
    const previousId = "thread:7:project5:codex13:native-thread";
    new WorkbenchTranscriptRepository(database).settle([
      { kind: "thread", threadId: previousId, ...input },
      {
        kind: "turn", threadId: previousId, turnId: "legacy-turn", harnessId: "codex",
        nativeLocation: input.native.nativeLocation, nativeThreadId: input.native.nativeThreadId,
        nativeTurnId: "native-turn", state: "completed", createdAt: 2, startedAt: 2, endedAt: 3, durationMs: 1,
      },
    ]);
    const canonical = identity.resolveNative(input.native)!;
    assert.notEqual(canonical.threadId, previousId);
    assert.equal(new WorkbenchThreadIdentityRepository(database).resolve({ threadId: previousId })?.threadId, canonical.threadId);
    assert.throws(() => identity.resolve({ threadId: previousId, projectId: "other-project" }), /project/iu);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("turn identity relinks its FK graph while retaining native and old public references", () => {
  const { database, identity } = setup();
  try {
    const input = metadata();
    const { threadId } = identity.observe(input);
    const previousTurnId = "opencode:turn:native-thread:first";
    new WorkbenchTranscriptRepository(database).settle([
      {
        kind: "turn", threadId, turnId: previousTurnId, harnessId: "codex",
        nativeLocation: input.native.nativeLocation, nativeThreadId: input.native.nativeThreadId,
        nativeTurnId: "native-turn", state: "completed", createdAt: 2, startedAt: 2, endedAt: 3, durationMs: 1,
      },
      {
        kind: "item", threadId, turnId: previousTurnId, lifecycle: "completed", observedAt: 3,
        item: {
          id: "native-item", type: "agentMessage", text: "Keep my body",
          phase: "commentary", delivery: null, questions: null, memoryCitation: null,
        },
      },
      { kind: "turnUsageContext", threadId, turnId: previousTurnId, model: "model", serviceTier: null, observedAt: 3 },
    ]);
    const beforeItems = database.prepare("SELECT * FROM thread_items").all() as Array<Record<string, string | number | null>>;
    const canonical = identity.resolveTurn({ threadId, turnId: previousTurnId })!;
    assert.notEqual(canonical.turnId, previousTurnId);
    assert.equal(canonical.native.nativeTurnId, "native-turn");
    assert.equal(canonical.turnIndex, 0);
    assert.equal(identity.resolveTurn({ threadId, turnId: previousTurnId })?.turnId, canonical.turnId);
    assert.equal(identity.resolveTurn({ threadId, turnId: "native-turn" })?.turnId, canonical.turnId);
    assert.equal(identity.resolveTurn({ threadId, turnId: canonical.turnId })?.turnId, canonical.turnId);
    assert.deepEqual(database.prepare("SELECT * FROM thread_items").all(),
      beforeItems.map((row) => ({ ...row, turn_id: canonical.turnId })));
    assert.deepEqual(database.prepare("SELECT turn_id FROM thread_turn_usage").all(), [{ turn_id: canonical.turnId }]);
    assert.deepEqual(database.prepare("SELECT turn_id FROM thread_turn_materializations").all(), [{ turn_id: canonical.turnId }]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("metadata-only turn admission is stable and rejects a borrowed turn from another native binding", () => {
  const { database, identity } = setup();
  try {
    const input = metadata();
    const { threadId } = identity.observe(input);
    const turn = {
      kind: "turn" as const, threadId, turnId: "native-turn", harnessId: "codex",
      nativeLocation: input.native.nativeLocation, nativeThreadId: input.native.nativeThreadId,
      nativeTurnId: "native-turn", state: "inProgress" as const, createdAt: 2,
      startedAt: 2, endedAt: null, durationMs: null,
    };
    const admitted = identity.observeTurn(turn);
    assert.notEqual(admitted.turnId, turn.turnId);
    assert.deepEqual(identity.observeTurn(turn), admitted);
    assert.deepEqual(database.prepare("SELECT turn_id FROM thread_turn_materializations").all(), []);
    assert.equal(identity.resolveNative(input.native)?.bindings[0]?.pending, false);
    new WorkbenchTranscriptRepository(database).settle([{
      ...turn, turnId: "secondary-turn", nativeThreadId: "secondary-native", nativeTurnId: "secondary-turn",
    }]);
    assert.throws(() => identity.observeTurn({
      ...turn, turnId: admitted.turnId, nativeThreadId: "secondary-native", nativeTurnId: null,
    }), /native|owner/iu);
    assert.deepEqual(identity.resolveTurn({ threadId, turnId: admitted.turnId }), admitted);
  } finally {
    database.close();
  }
});
