/*
 * No production exports. Protect parent counters and membership independently of child history.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchSubagentRelationshipRepository from "./WorkbenchSubagentRelationshipRepository";

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const identities = new WorkbenchThreadIdentityRepository(database);
  const observe = (nativeThreadId: string, harness: "codex" | "opencode") => identities.observe({
    native: { harness, nativeLocation: "C:/project", nativeThreadId },
    projectId: "project", projectRoot: "C:/project", title: nativeThreadId,
    createdAt: 1, updatedAt: 1, activityAt: 1,
  }).threadId;
  const parentThreadId = observe("parent", "codex");
  const childThreadId = observe("child", "opencode");
  const otherParentThreadId = observe("other-parent", "codex");
  return {
    database, parentThreadId, childThreadId, otherParentThreadId,
    repository: new WorkbenchSubagentRelationshipRepository(database),
    reservation: {
      reservationId: randomUUID(), parentThreadId, projectId: "project", harness: "opencode" as const,
      cwd: "C:/project", name: "lena", title: "check things", profileId: "review", profileName: "reviewer",
      createdAt: 1, updatedAt: 1,
    },
  };
}

test("cross-harness activation retains parent allocation and removing membership preserves thread history", () => {
  const { database, repository, reservation, parentThreadId, childThreadId, otherParentThreadId } = fixture();
  try {
    const { reservationId, ...reserved } = repository.reserve(reservation);
    const active = { ...reserved, threadId: childThreadId, updatedAt: 2 };
    repository.activate(parentThreadId, reservationId, active);
    assert.deepEqual(repository.getOwned(parentThreadId, "project", childThreadId), active);
    assert.equal(repository.getOwned(otherParentThreadId, "project", childThreadId), null);
    assert.equal(repository.getOwned(parentThreadId, "other-project", childThreadId), null);
    assert.equal(repository.remove(otherParentThreadId, childThreadId), false);
    assert.equal(repository.remove(parentThreadId, childThreadId), true);
    assert.equal(repository.getOwned(parentThreadId, "project", childThreadId), null);
    assert.deepEqual(repository.readParent(parentThreadId), {
      parentThreadId, nextDirectSubagentIndex: 1, relationships: [],
    });
    assert.ok(database.prepare("SELECT id FROM workbench_threads WHERE id = ?").get(childThreadId));
    const next = repository.reserve({ ...reservation, reservationId: randomUUID() });
    assert.equal(next.directSubagentIndex, 1);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("failed reservation and activation roll back allocation and leave the reservation usable", () => {
  const { database, repository, reservation, parentThreadId, childThreadId } = fixture();
  try {
    const { reservationId, ...reserved } = repository.reserve(reservation);
    assert.throws(() => repository.reserve({ ...reservation, reservationId: randomUUID(), name: "LENA" }), /already in use/);
    assert.equal(repository.readParent(parentThreadId)?.nextDirectSubagentIndex, 1);
    assert.throws(() => repository.activate(parentThreadId, reservationId, {
      ...reserved, threadId: randomUUID(), updatedAt: 2,
    }), /FOREIGN KEY/);
    assert.deepEqual(repository.readParent(parentThreadId)?.relationships, [
      { ...reserved, reservationId, kind: "reserved" },
    ]);
    const active = { ...reserved, threadId: childThreadId, updatedAt: 2 };
    repository.activate(parentThreadId, reservationId, active);
    assert.deepEqual(repository.getOwned(parentThreadId, "project", childThreadId), active);
  } finally {
    database.close();
  }
});

test("import preserves empty parent counters and rolls back inconsistent relationship batches", () => {
  const { database, repository, reservation, parentThreadId, otherParentThreadId } = fixture();
  try {
    repository.importParent({ parentThreadId, nextDirectSubagentIndex: 7, relationships: [] });
    assert.equal(repository.reserve(reservation).directSubagentIndex, 7);
    const first = {
      ...reservation, parentThreadId: otherParentThreadId, kind: "reserved" as const,
      reservationId: randomUUID(), directSubagentIndex: 2,
    };
    assert.throws(() => repository.importParent({
      parentThreadId: otherParentThreadId, nextDirectSubagentIndex: 5,
      relationships: [first, { ...first, reservationId: randomUUID(), directSubagentIndex: 3 }],
    }), /UNIQUE/);
    assert.equal(repository.readParent(otherParentThreadId), null);
    repository.importParent({
      parentThreadId: otherParentThreadId, nextDirectSubagentIndex: 5, relationships: [first],
    });
    assert.deepEqual(repository.readParent(otherParentThreadId), {
      parentThreadId: otherParentThreadId, nextDirectSubagentIndex: 5, relationships: [first],
    });
    assert.throws(database.transaction(() => {
      repository.remove(otherParentThreadId, first.reservationId);
      throw new Error("caller failed");
    }), /caller failed/);
    assert.deepEqual(repository.readParent(otherParentThreadId)?.relationships, [first]);
  } finally {
    database.close();
  }
});
