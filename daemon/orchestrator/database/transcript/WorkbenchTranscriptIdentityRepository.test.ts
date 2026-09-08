/*
 * Keywords: transcript, identity, permanent aliases, isolation, rollback.
 * No exports. Tests protect structural identity independently of recorder bodies and replaceable timeline data.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import Database from "better-sqlite3";

import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchTranscriptRepository from "./WorkbenchTranscriptRepository.ts";
import WorkbenchTranscriptIdentityRepository from "./WorkbenchTranscriptIdentityRepository.ts";

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const threads = new WorkbenchThreadIdentityRepository(database);
  const transcript = new WorkbenchTranscriptRepository(database);
  const createThread = (nativeThreadId: string) => threads.observe({
    native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId },
    projectId: "project", projectRoot: "C:/project", title: "Thread",
    createdAt: 1, updatedAt: 1, activityAt: 1,
  }).threadId;
  const threadId = createThread("native-thread");
  const otherThreadId = createThread("other-native");
  for (const [owner, native, turns] of [
    [threadId, "native-thread", ["first", "second"]],
    [otherThreadId, "other-native", ["other"]],
  ] as const) {
    transcript.settle([{
      kind: "turnCatalog", threadId: owner,
      catalog: [{
        kind: "thread", threadId: owner, projectId: "project", projectRoot: "C:/project",
        title: "Thread", createdAt: 1, updatedAt: 1, activityAt: 1,
      }, ...[...turns].map((turnId, turnIndex) => ({
        kind: "turn" as const, threadId: owner, turnId, turnIndex, harnessId: "codex",
        nativeLocation: "C:/project", nativeThreadId: native, nativeTurnId: turnId,
        state: "completed" as const, createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
      }))],
    }]);
  }
  return { database, threadId, otherThreadId, identity: new WorkbenchTranscriptIdentityRepository(database) };
}

test("item identity is durable before any body or timeline exists", () => {
  const { database, identity, threadId } = setup();
  try {
    const input = {
      threadId,
      sources: [{ turnId: "first", kind: "stable" as const, sourceId: "exec:native:command" }],
      legacyAliases: [{ turnId: "first", alias: "workbench:old:item" }],
    };
    const admitted = identity.admit(input);
    assert.match(admitted.itemId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);
    assert.equal(identity.admit(input).itemId, admitted.itemId);
    const reloaded = new WorkbenchTranscriptIdentityRepository(database);
    assert.equal(reloaded.resolve({ threadId, itemId: admitted.itemId })?.itemId, admitted.itemId);
    assert.equal(reloaded.resolve({ threadId, itemId: "workbench:old:item" })?.itemId, admitted.itemId);
    assert.deepEqual(database.prepare("SELECT id FROM thread_items").all(), []);
    assert.deepEqual(database.prepare("SELECT turn_id FROM thread_turn_materializations").all(), []);
  } finally {
    database.close();
  }
});

test("stable evidence follows one provider while provisional IDs remain turn-scoped", () => {
  const { database, identity, threadId, otherThreadId } = setup();
  try {
    const admit = (owner: string, turnId: string, kind: "stable" | "provisional") => identity.admit({
      threadId: owner, sources: [{ turnId, kind, sourceId: "item-1" }], legacyAliases: [],
    }).itemId;
    const first = admit(threadId, "first", "stable");
    assert.equal(admit(threadId, "second", "stable"), first);
    assert.notEqual(admit(otherThreadId, "other", "stable"), first);
    const provisional = admit(threadId, "first", "provisional");
    assert.notEqual(admit(threadId, "second", "provisional"), provisional);
    const resolved = identity.resolve({ threadId, itemId: "item-1" });
    assert.ok(resolved);
    assert.equal(resolved.threadId, threadId);
    assert.equal(new WorkbenchTranscriptIdentityRepository(database).resolve({ threadId, itemId: "item-1" })?.itemId, resolved.itemId);
    assert.equal(identity.resolve({ threadId, itemId: first })?.itemId, first);
    assert.equal(identity.resolve({ threadId, itemId: provisional })?.itemId, provisional);
  } finally {
    database.close();
  }
});

test("new structural admission reuses a retained alias only in its recorded turn", () => {
  const { database, identity, threadId } = setup();
  try {
    const retained = identity.admit({
      threadId, sources: [{ turnId: "first", kind: "provisional", sourceId: "item-1" }],
      legacyAliases: [{ turnId: "first", alias: "native-command" }],
    });
    const source = { turnId: "first", kind: "stable" as const, sourceId: "native-command" };
    assert.equal(identity.admit({ threadId, sources: [source], legacyAliases: [] }).itemId, retained.itemId);
    assert.notEqual(identity.admit({
      threadId, sources: [{ ...source, turnId: "second", kind: "provisional" }], legacyAliases: [],
    }).itemId, retained.itemId);
    assert.equal(new WorkbenchTranscriptIdentityRepository(database).resolve({
      threadId, turnId: "first", itemId: "native-command",
    })?.itemId, retained.itemId);
  } finally {
    database.close();
  }
});

test("public item identity outranks a source alias and cannot move to another thread", () => {
  const { database, identity, threadId, otherThreadId } = setup();
  try {
    const itemId = randomUUID();
    identity.admit({ threadId, itemId, sources: [], legacyAliases: [] });
    const alias = identity.admit({
      threadId, sources: [{ turnId: "first", kind: "stable", sourceId: itemId }], legacyAliases: [],
    });
    assert.notEqual(alias.itemId, itemId);
    assert.equal(identity.resolve({ threadId, itemId })?.itemId, itemId);
    assert.throws(() => identity.admit({
      threadId: otherThreadId, itemId, sources: [], legacyAliases: [],
    }), /thread/iu);
    assert.equal(identity.resolve({ threadId: otherThreadId, itemId }), null);
  } finally {
    database.close();
  }
});

test("conflicting aliases warn without losing either identity or blocking structural admission", (context) => {
  const { database, identity, threadId } = setup();
  const warnings = context.mock.method(console, "warn", () => undefined);
  try {
    const source = { turnId: "first", kind: "stable" as const, sourceId: "native-item" };
    const alias = { turnId: "first", alias: "retained-reference" };
    const live = identity.admit({ threadId, sources: [source], legacyAliases: [] });
    const retained = identity.admit({ threadId, sources: [], legacyAliases: [alias] });
    for (let pass = 0; pass < 2; pass++) {
      const admitted = identity.admit({ threadId, sources: [source], legacyAliases: [alias] });
      assert.equal(admitted.itemId, live.itemId);
      assert.equal(identity.resolve({ threadId, itemId: source.sourceId })?.itemId, live.itemId);
      assert.equal(identity.resolve({ threadId, itemId: alias.alias })?.itemId, retained.itemId);
      assert.equal(identity.resolve({ threadId, itemId: retained.itemId })?.itemId, retained.itemId);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    }
    assert.equal(warnings.mock.callCount(), 2);
    assert.deepEqual(warnings.mock.calls[0]!.arguments[1], {
      threadId, selectedItemId: live.itemId, candidates: 2,
    });
  } finally { database.close(); }
});

test("cross-thread evidence rolls back the entire admission", () => {
  const { database, identity, threadId, otherThreadId } = setup();
  try {
    const itemId = randomUUID();
    assert.throws(() => identity.admit({
      threadId, itemId,
      sources: [
        { turnId: "first", kind: "stable", sourceId: "new-source" },
        { turnId: "other", kind: "stable", sourceId: "foreign-source" },
      ],
      legacyAliases: [],
    }), /thread/iu);
    assert.equal(identity.resolve({ threadId, itemId }), null);
    assert.equal(identity.resolve({ threadId, itemId: "new-source" }), null);
    assert.equal(identity.resolve({ threadId: otherThreadId, itemId: "foreign-source" }), null);
  } finally {
    database.close();
  }
});

test("same-fact reconciliation retains old public and legacy references on the survivor", () => {
  const { database, identity, threadId } = setup();
  try {
    const provisional = identity.admit({
      threadId,
      sources: [{ turnId: "first", kind: "provisional", sourceId: "item-1" }],
      legacyAliases: [{ turnId: "first", alias: "old-questionnaire-item" }],
    });
    const live = identity.admit({
      threadId,
      sources: [{ turnId: "first", kind: "stable", sourceId: "native-item" }],
      legacyAliases: [],
    });
    database.transaction(() => identity.merge({
      threadId, turnId: "first", fromItemId: provisional.itemId, toItemId: live.itemId,
    }))();
    const reloaded = new WorkbenchTranscriptIdentityRepository(database);
    for (const alias of [provisional.itemId, "item-1", "old-questionnaire-item", "native-item", live.itemId]) {
      assert.equal(reloaded.resolve({ threadId, itemId: alias })?.itemId, live.itemId);
    }
    assert.equal(identity.admit({
      threadId, sources: [{ turnId: "first", kind: "provisional", sourceId: "item-1" }], legacyAliases: [],
    }).itemId, live.itemId);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("a rolled back same-fact merge leaves both identities and all aliases intact", () => {
  const { database, identity, threadId } = setup();
  try {
    const first = identity.admit({
      threadId, sources: [{ turnId: "first", kind: "provisional", sourceId: "item-1" }], legacyAliases: [],
    });
    const second = identity.admit({
      threadId, sources: [{ turnId: "first", kind: "stable", sourceId: "native-item" }], legacyAliases: [],
    });
    assert.throws(() => identity.merge({
      threadId, turnId: "first", fromItemId: first.itemId, toItemId: second.itemId,
    }), /transaction/iu);
    assert.throws(() => database.transaction(() => {
      identity.merge({ threadId, turnId: "first", fromItemId: first.itemId, toItemId: second.itemId });
      throw new Error("body reconciliation failed");
    })(), /body reconciliation/iu);
    assert.equal(identity.resolve({ threadId, itemId: "item-1" })?.itemId, first.itemId);
    assert.equal(identity.resolve({ threadId, itemId: "native-item" })?.itemId, second.itemId);
    assert.equal(identity.resolve({ threadId, itemId: first.itemId })?.itemId, first.itemId);
  } finally {
    database.close();
  }
});

test("identity reconciliation cannot cascade-delete a body that has not been transferred", () => {
  const { database, identity, threadId } = setup();
  try {
    const first = identity.admit({
      threadId, sources: [{ turnId: "first", kind: "provisional", sourceId: "item-1" }], legacyAliases: [],
    });
    const second = identity.admit({
      threadId, sources: [{ turnId: "first", kind: "stable", sourceId: "native-item" }], legacyAliases: [],
    });
    new WorkbenchTranscriptRepository(database).settle([
      {
        kind: "turn", threadId, turnId: "first", harnessId: "codex",
        nativeLocation: "C:/project", nativeThreadId: "native-thread", nativeTurnId: "first",
        state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
      },
      {
        kind: "item", threadId, turnId: "first", lifecycle: "completed", observedAt: 3,
        item: {
          type: "agentMessage", id: "item-1", text: "Keep this body",
          phase: "commentary", delivery: null, questions: null, memoryCitation: null,
        },
      },
    ]);
    database.prepare("UPDATE thread_items SET public_id = ? WHERE source_id = 'item-1'").run(first.itemId);
    assert.throws(() => database.transaction(() => identity.merge({
      threadId, turnId: "first", fromItemId: first.itemId, toItemId: second.itemId,
    }))(), /body/iu);
    assert.equal(identity.resolve({ threadId, itemId: "item-1" })?.itemId, first.itemId);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM thread_items").get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
});
