/*
 * No exports. Tests protect structural identity independently of recorder bodies and replaceable timeline data.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { captureTestOutput } from "../../../../test/capture-test-output.mts";

import Database from "better-sqlite3";

import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchTranscriptRepository from "./WorkbenchTranscriptRepository.ts";
import WorkbenchTranscriptIdentityRepository from "./WorkbenchTranscriptIdentityRepository.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  NativeThreadId: {
    "native-thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("native-thread"),
  },
  NativeTurnId: {
    "first": fixtureIdentitySchemas.NativeTurnIdSchema.parse("first"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("local:///project"),
  },
  WorkbenchTurnId: {
    "first": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("first"),
    "other": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("other"),
    "second": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("second"),
  },
};

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const threads = new WorkbenchThreadIdentityRepository(database);
  const transcript = new WorkbenchTranscriptRepository(database);
  const createThread = (nativeThreadId: string) => threads.observe({
    native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(nativeThreadId) },
    projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project", title: "Thread",
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
        kind: "thread", threadId: owner, projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project",
        title: "Thread", createdAt: 1, updatedAt: 1, activityAt: 1,
      }, ...[...turns].map((turnId, turnIndex) => ({
        kind: "turn" as const, threadId: owner, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId), turnIndex, harnessId: "codex",
        nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(native), nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(turnId),
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
      sources: [{ turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("first"), kind: "stable" as const, sourceId: "exec:native:command" }],
      legacyAliases: [{ turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("first"), alias: "workbench:old:item" }],
    };
    const admitted = identity.admit(input);
    assert.match(admitted.itemId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);
    assert.equal(identity.admit(input).itemId, admitted.itemId);
    const reloaded = new WorkbenchTranscriptIdentityRepository(database);
    assert.equal(reloaded.resolve({ threadId, itemId: admitted.itemId })?.itemId, admitted.itemId);
    assert.equal(reloaded.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("workbench:old:item") })?.itemId, admitted.itemId);
    assert.deepEqual(database.prepare("SELECT id FROM thread_items").all(), []);
    assert.deepEqual(database.prepare("SELECT turn_id FROM thread_turn_materializations").all(), []);
  } finally {
    database.close();
  }
});

test("stable evidence follows one provider while provisional IDs remain turn-scoped", (context) => {
  const warnings = captureTestOutput(context, process.stderr, text => text.startsWith("[workbench-transcript] conflicting aliases retained"));
  context.after(() => assert.equal(warnings.length, 2));
  const { database, identity, threadId, otherThreadId } = setup();
  try {
    const admit = (owner: string, turnId: string, kind: "stable" | "provisional") => identity.admit({
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(owner), sources: [{ turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId), kind, sourceId: "item-1" }], legacyAliases: [],
    }).itemId;
    const first = admit(threadId, "first", "stable");
    assert.equal(admit(threadId, "second", "stable"), first);
    assert.notEqual(admit(otherThreadId, "other", "stable"), first);
    const provisional = admit(threadId, "first", "provisional");
    assert.notEqual(admit(threadId, "second", "provisional"), provisional);
    const resolved = identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("item-1") });
    assert.ok(resolved);
    assert.equal(resolved.threadId, threadId);
    assert.equal(new WorkbenchTranscriptIdentityRepository(database).resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("item-1") })?.itemId, resolved.itemId);
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
      threadId, sources: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], kind: "provisional", sourceId: "item-1" }],
      legacyAliases: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], alias: "native-command" }],
    });
    const source = { turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("first"), kind: "stable" as const, sourceId: "native-command" };
    assert.equal(identity.admit({ threadId, sources: [source], legacyAliases: [] }).itemId, retained.itemId);
    assert.notEqual(identity.admit({
      threadId, sources: [{ ...source, turnId: fixtureIdentityValues.WorkbenchTurnId["second"], kind: "provisional" }], legacyAliases: [],
    }).itemId, retained.itemId);
    assert.equal(new WorkbenchTranscriptIdentityRepository(database).resolve({
      threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("native-command"),
    })?.itemId, retained.itemId);
  } finally {
    database.close();
  }
});

test("public item identity outranks a source alias and cannot move to another thread", () => {
  const { database, identity, threadId, otherThreadId } = setup();
  try {
    const itemId = fixtureIdentitySchemas.WorkbenchItemIdSchema.parse(randomUUID());
    identity.admit({ threadId, itemId, sources: [], legacyAliases: [] });
    const alias = identity.admit({
      threadId, sources: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], kind: "stable", sourceId: itemId }], legacyAliases: [],
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
    const source = { turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("first"), kind: "stable" as const, sourceId: "native-item" };
    const alias = { turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("first"), alias: "retained-reference" };
    const live = identity.admit({ threadId, sources: [source], legacyAliases: [] });
    const retained = identity.admit({ threadId, sources: [], legacyAliases: [alias] });
    for (let pass = 0; pass < 2; pass++) {
      const admitted = identity.admit({ threadId, sources: [source], legacyAliases: [alias] });
      assert.equal(admitted.itemId, live.itemId);
      assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(source.sourceId) })?.itemId, live.itemId);
      assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(alias.alias) })?.itemId, retained.itemId);
      assert.equal(identity.resolve({ threadId, itemId: retained.itemId })?.itemId, retained.itemId);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    }
    assert.equal(warnings.mock.callCount(), 2);
    assert.deepEqual(warnings.mock.calls[0]!.arguments[1], {
      threadId, selectedItemId: live.itemId, candidates: 2,
    });
  } finally { database.close(); }
});

function splitUserMessage(clientOnStructural = false) {
  const fixture = setup();
  const { database, identity, threadId } = fixture;
  const provider = { turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("first"), kind: "stable" as const, sourceId: "native-message" };
  const client = { turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("first"), kind: "client" as const, sourceId: "submitted-message" };
  const structural = identity.admit({ threadId, sources: [provider, ...(clientOnStructural ? [client] : [])], legacyAliases: [] });
  const recorded = identity.admit({
    threadId, sources: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], kind: "provisional", sourceId: "item-1" }, ...(!clientOnStructural ? [client] : [])],
    legacyAliases: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], alias: "retained-message" }],
  });
  const repository = new WorkbenchTranscriptRepository(database);
  repository.settle([{
    kind: "turn", threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], harnessId: "codex",
    nativeLocation: "C:/project", nativeThreadId: fixtureIdentityValues.NativeThreadId["native-thread"], nativeTurnId: fixtureIdentityValues.NativeTurnId["first"],
    state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
  }, {
    kind: "item", threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], publicItemId: recorded.itemId,
    lifecycle: "completed", observedAt: 3,
    item: { type: "userMessage", id: "item-1", clientId: client.sourceId,
      content: [{ type: "text", text: "keep this input", text_elements: [] }] },
  }]);
  return { ...fixture, provider, client, structural, recorded, repository };
}

for (const clientOnStructural of [false, true]) {
  test(`client correlation joins a bodyless provider identity without changing the recorded message (client on structural ${clientOnStructural})`, (context) => {
    const { database, identity, threadId, provider, client, structural, recorded } = splitUserMessage(clientOnStructural);
    const warnings = context.mock.method(console, "warn", () => undefined);
    try {
      const before = database.prepare("SELECT * FROM thread_items").all();
      const bodies = database.prepare("SELECT * FROM thread_item_user_messages").all();
      const incoming = clientOnStructural ? { ...provider, kind: "provisional" as const, sourceId: "item-1" } : provider;
      for (const sources of [[incoming, client], [client, provider]]) {
        assert.equal(identity.admit({ threadId, sources, legacyAliases: [] }).itemId, recorded.itemId);
      }
      const reloaded = new WorkbenchTranscriptIdentityRepository(database);
      for (const reference of [structural.itemId, recorded.itemId, provider.sourceId, client.sourceId, "item-1", "retained-message"]) {
        assert.equal(reloaded.resolve({ threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(reference) })?.itemId, recorded.itemId);
      }
      assert.equal(reloaded.admit({
        threadId, itemId: structural.itemId, sources: [provider, client], legacyAliases: [],
      }).itemId, recorded.itemId, "An old public reference must not recreate the merged identity.");
      assert.deepEqual(database.prepare("SELECT * FROM thread_items").all(), before);
      assert.deepEqual(database.prepare("SELECT * FROM thread_item_user_messages").all(), bodies);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.equal(warnings.mock.callCount(), 0);
    } finally { database.close(); }
  });
}

for (const retained of [false, true]) {
  test(`explicit compaction alias joins the bodyless identity (previously retained ${retained})`, (context) => {
    const { database, identity, threadId } = setup();
    const warnings = context.mock.method(console, "warn", () => undefined);
    try {
      const stable = { turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("first"), sourceId: "native-compaction", kind: "stable" as const };
      const provisional = { ...stable, sourceId: "item-1", kind: "provisional" as const };
      const structural = identity.admit({ threadId, sources: [stable], legacyAliases: [] });
      const recorded = identity.admit({ threadId, sources: [provisional], legacyAliases: [] });
      new WorkbenchTranscriptRepository(database).settle([{
        kind: "turn", threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], harnessId: "codex",
        nativeLocation: "C:/project", nativeThreadId: fixtureIdentityValues.NativeThreadId["native-thread"], nativeTurnId: fixtureIdentityValues.NativeTurnId["first"],
        state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
      }, {
        kind: "item", threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], publicItemId: recorded.itemId,
        lifecycle: "completed", observedAt: 3, item: { type: "contextCompaction", id: provisional.sourceId },
      }]);
      const before = database.prepare("SELECT * FROM thread_items").all();
      identity.admit({ threadId, sources: [stable, provisional], legacyAliases: [] });
      assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(stable.sourceId) })?.itemId, structural.itemId);
      assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(provisional.sourceId) })?.itemId, recorded.itemId);
      assert.ok(warnings.mock.callCount() > 0, "Source spelling alone must not merge identities.");
      warnings.mock.resetCalls();
      if (retained) database.prepare(`
        INSERT INTO workbench_transcript_item_legacy_aliases(thread_id, turn_id, alias, item_identity_id) VALUES (?, ?, ?, ?)
      `).run(threadId, "first", provisional.sourceId, structural.itemId);
      const admission = retained
        ? { threadId, sources: [provisional], legacyAliases: [] }
        : { threadId, sources: [stable], legacyAliases: [{ turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("first"), alias: provisional.sourceId }] };
      for (let pass = 0; pass < 2; pass++) {
        assert.equal(identity.admit(admission).itemId, recorded.itemId);
      }
      const reloaded = new WorkbenchTranscriptIdentityRepository(database);
      for (const reference of [stable.sourceId, provisional.sourceId, structural.itemId, recorded.itemId]) {
        assert.equal(reloaded.resolve({ threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(reference) })?.itemId, recorded.itemId);
      }
      assert.deepEqual(database.prepare("SELECT * FROM thread_items").all(), before);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.equal(warnings.mock.callCount(), 0);
    } finally { database.close(); }
  });
}

test("correlated identity admission rolls back aliases with the surrounding transaction", () => {
  const { database, identity, threadId, provider, client, structural, recorded } = splitUserMessage();
  try {
    assert.throws(() => database.transaction(() => {
      assert.equal(identity.admit({ threadId, sources: [provider, client], legacyAliases: [] }).itemId, recorded.itemId);
      throw new Error("later admission failed");
    })(), /later admission failed/u);
    assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(provider.sourceId) })?.itemId, structural.itemId);
    assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(client.sourceId) })?.itemId, recorded.itemId);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

for (const conflict of ["other-body", "other-client", "other-turn", "body-client", "third-owner"] as const) {
  test(`client correlation preserves conflicting evidence (${conflict})`, (context) => {
    const { database, identity, threadId, provider, client, structural, recorded, repository } = splitUserMessage();
    const warnings = context.mock.method(console, "warn", () => undefined);
    try {
      if (conflict === "other-body") repository.settle([{
        kind: "item", threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], publicItemId: structural.itemId,
        lifecycle: "completed", observedAt: 3,
        item: { type: "userMessage", id: provider.sourceId, clientId: null, content: [] },
      }]);
      if (conflict === "other-client") identity.admit({
        threadId, itemId: structural.itemId,
        sources: [{ ...client, sourceId: "different-submission" }], legacyAliases: [],
      });
      if (conflict === "other-turn") identity.admit({
        threadId, itemId: structural.itemId, sources: [{ ...provider, turnId: fixtureIdentityValues.WorkbenchTurnId["second"] }], legacyAliases: [],
      });
      if (conflict === "body-client") database.prepare("UPDATE thread_item_user_messages SET client_id = ?").run("different-submission");
      const legacyAliases = conflict === "third-owner" ? [{ turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("first"), alias: "unrelated" }] : [];
      if (legacyAliases.length) identity.admit({ threadId, sources: [], legacyAliases });
      const before = database.prepare("SELECT * FROM thread_items").all();
      identity.admit({ threadId, sources: [provider, client], legacyAliases });
      assert.equal(identity.resolve({ threadId, itemId: structural.itemId })?.itemId, structural.itemId);
      assert.equal(identity.resolve({ threadId, itemId: recorded.itemId })?.itemId, recorded.itemId);
      assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(provider.sourceId) })?.itemId, structural.itemId);
      assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(client.sourceId) })?.itemId, recorded.itemId);
      assert.deepEqual(database.prepare("SELECT * FROM thread_items").all(), before);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.ok(warnings.mock.callCount() > 0);
    } finally { database.close(); }
  });
}

test("cross-thread evidence rolls back the entire admission", () => {
  const { database, identity, threadId, otherThreadId } = setup();
  try {
    const itemId = fixtureIdentitySchemas.WorkbenchItemIdSchema.parse(randomUUID());
    assert.throws(() => identity.admit({
      threadId, itemId,
      sources: [
        { turnId: fixtureIdentityValues.WorkbenchTurnId["first"], kind: "stable", sourceId: "new-source" },
        { turnId: fixtureIdentityValues.WorkbenchTurnId["other"], kind: "stable", sourceId: "foreign-source" },
      ],
      legacyAliases: [],
    }), /thread/iu);
    assert.equal(identity.resolve({ threadId, itemId }), null);
    assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("new-source") }), null);
    assert.equal(identity.resolve({ threadId: otherThreadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("foreign-source") }), null);
  } finally {
    database.close();
  }
});

test("same-fact reconciliation retains old public and legacy references on the survivor", () => {
  const { database, identity, threadId } = setup();
  try {
    const provisional = identity.admit({
      threadId,
      sources: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], kind: "provisional", sourceId: "item-1" }],
      legacyAliases: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], alias: "old-questionnaire-item" }],
    });
    const live = identity.admit({
      threadId,
      sources: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], kind: "stable", sourceId: "native-item" }],
      legacyAliases: [],
    });
    database.transaction(() => identity.merge({
      threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], fromItemId: provisional.itemId, toItemId: live.itemId,
    }))();
    const reloaded = new WorkbenchTranscriptIdentityRepository(database);
    for (const alias of [provisional.itemId, "item-1", "old-questionnaire-item", "native-item", live.itemId]) {
      assert.equal(reloaded.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse(alias) })?.itemId, live.itemId);
    }
    assert.equal(identity.admit({
      threadId, sources: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], kind: "provisional", sourceId: "item-1" }], legacyAliases: [],
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
      threadId, sources: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], kind: "provisional", sourceId: "item-1" }], legacyAliases: [],
    });
    const second = identity.admit({
      threadId, sources: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], kind: "stable", sourceId: "native-item" }], legacyAliases: [],
    });
    assert.throws(() => identity.merge({
      threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], fromItemId: first.itemId, toItemId: second.itemId,
    }), /transaction/iu);
    assert.throws(() => database.transaction(() => {
      identity.merge({ threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], fromItemId: first.itemId, toItemId: second.itemId });
      throw new Error("body reconciliation failed");
    })(), /body reconciliation/iu);
    assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("item-1") })?.itemId, first.itemId);
    assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("native-item") })?.itemId, second.itemId);
    assert.equal(identity.resolve({ threadId, itemId: first.itemId })?.itemId, first.itemId);
  } finally {
    database.close();
  }
});

test("identity reconciliation cannot cascade-delete a body that has not been transferred", () => {
  const { database, identity, threadId } = setup();
  try {
    const first = identity.admit({
      threadId, sources: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], kind: "provisional", sourceId: "item-1" }], legacyAliases: [],
    });
    const second = identity.admit({
      threadId, sources: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["first"], kind: "stable", sourceId: "native-item" }], legacyAliases: [],
    });
    new WorkbenchTranscriptRepository(database).settle([
      {
        kind: "turn", threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], harnessId: "codex",
        nativeLocation: "C:/project", nativeThreadId: fixtureIdentityValues.NativeThreadId["native-thread"], nativeTurnId: fixtureIdentityValues.NativeTurnId["first"],
        state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
      },
      {
        kind: "item", threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], lifecycle: "completed", observedAt: 3,
        item: {
          type: "agentMessage", id: "item-1", text: "Keep this body",
          phase: "commentary", delivery: null, questions: null, memoryCitation: null,
        },
      },
    ]);
    database.prepare("UPDATE thread_items SET public_id = ? WHERE source_id = 'item-1'").run(first.itemId);
    assert.throws(() => database.transaction(() => identity.merge({
      threadId, turnId: fixtureIdentityValues.WorkbenchTurnId["first"], fromItemId: first.itemId, toItemId: second.itemId,
    }))(), /body/iu);
    assert.equal(identity.resolve({ threadId, itemId: fixtureIdentitySchemas.ItemReferenceSchema.parse("item-1") })?.itemId, first.itemId);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM thread_items").get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
});
