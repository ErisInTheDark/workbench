/*
 * No exports. Tests protect relational transcript source identity independently of body recording.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import Database from "better-sqlite3";

import * as identitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import WorkbenchTranscriptRepository from "./WorkbenchTranscriptRepository.ts";
import WorkbenchTranscriptIdentityRepository from "./WorkbenchTranscriptIdentityRepository.ts";
import type { WorkbenchTranscriptItemSource } from "./workbench-transcript-types.ts";

const firstTurn = identitySchemas.WorkbenchTurnIdSchema.parse("first");
const secondTurn = identitySchemas.WorkbenchTurnIdSchema.parse("second");
const otherTurn = identitySchemas.WorkbenchTurnIdSchema.parse("other");

function source(
  turnId: identitySchemas.WorkbenchTurnId,
  kind: WorkbenchTranscriptItemSource["kind"],
  reference: string,
  component: WorkbenchTranscriptItemSource["component"] = { kind: "item", index: 0 },
): WorkbenchTranscriptItemSource {
  return { turnId, kind, reference, component };
}

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const threads = new WorkbenchThreadIdentityRepository(database);
  const transcript = new WorkbenchTranscriptRepository(database);
  const createThread = (nativeThreadId: string) => threads.observe({
    native: {
      harness: "codex",
      nativeLocation: "C:/project",
      nativeThreadId: identitySchemas.NativeThreadIdSchema.parse(nativeThreadId),
    },
    projectId: testProjectIds.project,
    projectRoot: "C:/project",
    title: "Thread",
    createdAt: 1,
    updatedAt: 1,
    activityAt: 1,
  }).threadId;
  const threadId = createThread("native-thread");
  const otherThreadId = createThread("other-native");
  for (const [owner, native, turns] of [
    [threadId, "native-thread", ["first", "second"]],
    [otherThreadId, "other-native", ["other"]],
  ] as const) {
    const catalog = [{
      kind: "thread" as const,
      threadId: owner,
      projectId: testProjectIds.project,
      projectRoot: "C:/project",
      title: "Thread",
      createdAt: 1,
      updatedAt: 1,
      activityAt: 1,
    }, ...turns.map((turnId, turnIndex) => ({
      kind: "turn" as const,
      threadId: owner,
      turnId: identitySchemas.WorkbenchTurnIdSchema.parse(turnId),
      turnIndex,
      harnessId: "codex",
      nativeLocation: "C:/project",
      nativeThreadId: identitySchemas.NativeThreadIdSchema.parse(native),
      nativeTurnId: identitySchemas.NativeTurnIdSchema.parse(turnId),
      state: "completed" as const,
      createdAt: 1,
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
    }))];
    transcript.settle([{
      kind: "turnCatalog",
      threadId: owner,
      catalog,
    }]);
    transcript.settle([{
      kind: "canonicalWindow",
      contentVersion: 3,
      materializedTurnIds: turns.map((turnId) => identitySchemas.WorkbenchTurnIdSchema.parse(turnId)),
      observations: catalog,
      threadId: owner,
    }]);
  }
  return {
    database,
    threadId,
    otherThreadId,
    identity: new WorkbenchTranscriptIdentityRepository(database),
  };
}

test("structured source identity is durable before any transcript body exists", () => {
  const { database, identity, threadId } = setup();
  try {
    const input = {
      threadId,
      sources: [source(firstTurn, "stable", "native-message", { kind: "text" as const, index: 2 })],
    };
    const admitted = identity.admit(input);
    assert.equal(identity.admit(input).itemId, admitted.itemId);
    assert.equal(new WorkbenchTranscriptIdentityRepository(database).resolve({
      threadId,
      turnId: firstTurn,
      itemId: identitySchemas.ItemReferenceSchema.parse("native-message"),
    }), null, "component references must not masquerade as whole-item references");
    assert.deepEqual(database.prepare("SELECT id FROM thread_items").all(), []);
    assert.deepEqual(database.prepare(`
      SELECT reference, component_kind, component_index
      FROM workbench_transcript_item_source_aliases
    `).all(), [{ reference: "native-message", component_kind: "text", component_index: 2 }]);
  } finally {
    database.close();
  }
});

test("stable evidence follows one provider while provisional evidence remains turn-local", () => {
  const { database, identity, threadId, otherThreadId } = setup();
  try {
    const first = identity.admit({ threadId, sources: [source(firstTurn, "stable", "native-item")] }).itemId;
    assert.equal(identity.admit({ threadId, sources: [source(secondTurn, "stable", "native-item")] }).itemId, first);
    assert.notEqual(identity.admit({
      threadId: otherThreadId,
      sources: [source(otherTurn, "stable", "native-item")],
    }).itemId, first);
    const provisional = identity.admit({
      threadId,
      sources: [source(firstTurn, "provisional", "item-1")],
    }).itemId;
    assert.notEqual(identity.admit({
      threadId,
      sources: [source(secondTurn, "provisional", "item-1")],
    }).itemId, provisional);
  } finally {
    database.close();
  }
});

test("component coordinates independently identify text and reasoning within one provider message", () => {
  const { database, identity, threadId } = setup();
  try {
    const text = identity.admit({
      threadId,
      sources: [source(firstTurn, "stable", "assistant-message", { kind: "text", index: 0 })],
    });
    const reasoning = identity.admit({
      threadId,
      sources: [source(firstTurn, "stable", "assistant-message", { kind: "reasoning", index: 0 })],
    });
    const secondText = identity.admit({
      threadId,
      sources: [source(firstTurn, "stable", "assistant-message", { kind: "text", index: 1 })],
    });
    assert.notEqual(text.itemId, reasoning.itemId);
    assert.notEqual(text.itemId, secondText.itemId);
    assert.equal(identity.admit({
      threadId,
      sources: [source(firstTurn, "stable", "assistant-message", { kind: "text", index: 0 })],
    }).itemId, text.itemId);
  } finally {
    database.close();
  }
});

test("co-occurring structured references merge one bodyless identity into the body owner", () => {
  const { database, identity, threadId } = setup();
  try {
    const stable = source(firstTurn, "stable", "native-message");
    const provisional = source(firstTurn, "provisional", "item-1");
    const structural = identity.admit({ threadId, sources: [stable] });
    const recorded = identity.admit({ threadId, sources: [provisional] });
    new WorkbenchTranscriptRepository(database).settle([{
      kind: "item",
      threadId,
      turnId: firstTurn,
      publicItemId: recorded.itemId,
      lifecycle: "completed",
      observedAt: 3,
      item: {
        type: "agentMessage",
        id: "item-1",
        text: "kept",
        phase: "commentary",
        delivery: null,
        questions: null,
        memoryCitation: null,
      },
    }]);
    assert.equal(identity.admit({ threadId, sources: [stable, provisional] }).itemId, recorded.itemId);
    const reloaded = new WorkbenchTranscriptIdentityRepository(database);
    for (const reference of ["native-message", "item-1"]) {
      assert.equal(reloaded.resolve({
        threadId,
        turnId: firstTurn,
        itemId: identitySchemas.ItemReferenceSchema.parse(reference),
      })?.itemId, recorded.itemId);
    }
    assert.equal(reloaded.resolve({ threadId, itemId: structural.itemId }), null);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM thread_items").get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
});

test("conflicting source owners warn and remain separate without a one-body proof", (context) => {
  const { database, identity, threadId } = setup();
  const warnings = context.mock.method(console, "warn", () => undefined);
  try {
    const stable = source(firstTurn, "stable", "native-item");
    const provisional = source(firstTurn, "provisional", "item-1");
    const first = identity.admit({ threadId, sources: [stable] });
    const second = identity.admit({ threadId, sources: [provisional] });
    assert.equal(identity.admit({ threadId, sources: [stable, provisional] }).itemId, first.itemId);
    assert.equal(identity.resolve({
      threadId,
      turnId: firstTurn,
      itemId: identitySchemas.ItemReferenceSchema.parse("native-item"),
    })?.itemId, first.itemId);
    assert.equal(identity.resolve({
      threadId,
      turnId: firstTurn,
      itemId: identitySchemas.ItemReferenceSchema.parse("item-1"),
    })?.itemId, second.itemId);
    assert.equal(warnings.mock.callCount(), 1);
  } finally {
    database.close();
  }
});

test("cross-thread evidence rolls back the entire admission", () => {
  const { database, identity, threadId, otherThreadId } = setup();
  try {
    const itemId = identitySchemas.WorkbenchItemIdSchema.parse(randomUUID());
    assert.throws(() => identity.admit({
      threadId,
      itemId,
      sources: [
        source(firstTurn, "stable", "new-source"),
        source(otherTurn, "stable", "foreign-source"),
      ],
    }), /thread/iu);
    assert.equal(identity.resolve({ threadId, itemId }), null);
    assert.equal(identity.resolve({
      threadId: otherThreadId,
      itemId: identitySchemas.ItemReferenceSchema.parse("foreign-source"),
    }), null);
  } finally {
    database.close();
  }
});

test("a rolled-back merge leaves both identities and their sources intact", () => {
  const { database, identity, threadId } = setup();
  try {
    const first = identity.admit({
      threadId,
      sources: [source(firstTurn, "provisional", "item-1")],
    });
    const second = identity.admit({
      threadId,
      sources: [source(firstTurn, "stable", "native-item")],
    });
    assert.throws(() => database.transaction(() => {
      identity.merge({
        threadId,
        turnId: firstTurn,
        fromItemId: first.itemId,
        toItemId: second.itemId,
      });
      throw new Error("later work failed");
    })(), /later work failed/u);
    assert.equal(identity.resolve({
      threadId,
      itemId: identitySchemas.ItemReferenceSchema.parse("item-1"),
    })?.itemId, first.itemId);
    assert.equal(identity.resolve({
      threadId,
      itemId: identitySchemas.ItemReferenceSchema.parse("native-item"),
    })?.itemId, second.itemId);
  } finally {
    database.close();
  }
});

test("identity reconciliation cannot cascade-delete an untransferred body", () => {
  const { database, identity, threadId } = setup();
  try {
    const first = identity.admit({
      threadId,
      sources: [source(firstTurn, "provisional", "item-1")],
    });
    const second = identity.admit({
      threadId,
      sources: [source(firstTurn, "stable", "native-item")],
    });
    new WorkbenchTranscriptRepository(database).settle([{
      kind: "item",
      threadId,
      turnId: firstTurn,
      publicItemId: first.itemId,
      lifecycle: "completed",
      observedAt: 3,
      item: {
        type: "agentMessage",
        id: "item-1",
        text: "keep this body",
        phase: "commentary",
        delivery: null,
        questions: null,
        memoryCitation: null,
      },
    }]);
    assert.throws(() => database.transaction(() => identity.merge({
      threadId,
      turnId: firstTurn,
      fromItemId: first.itemId,
      toItemId: second.itemId,
    }))(), /body/iu);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM thread_items").get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
});
