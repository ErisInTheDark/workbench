/*
 * No production exports. Protect layout round trips and subsequent interaction semantics.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  getProjectQualifiedThreadDisplayKey, moveThreadDisplayLayoutItem, type ThreadDisplayLayout,
} from "workbench-shared/workbench/thread/thread-display-layout";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadStateLayoutRepository from "./WorkbenchThreadStateLayoutRepository";

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const identities = new WorkbenchThreadIdentityRepository(database);
  const references = ["a", "b", "c", "d"].map((nativeThreadId) => identities.observe({
    native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId },
    projectId: "project", projectRoot: "C:/project", title: nativeThreadId,
    createdAt: 1, updatedAt: 1, activityAt: 1,
  }));
  const repository = new WorkbenchThreadStateLayoutRepository(database, {
    resolveThread(projectId, harness, threadId) {
      const reference = identities.resolve({ projectId, harness, threadId });
      if (!reference) throw new Error("missing thread");
      return reference.threadId;
    },
    readThread(threadId) {
      const reference = references.find((value) => value.threadId === threadId)!;
      return { projectId: reference.projectId, harness: "codex", threadId: reference.bindings[0]!.nativeThreadId };
    },
  });
  return { database, repository };
}

test("layout reload preserves explicit empty positions, implied references and future move behaviour", () => {
  const { database, repository } = fixture();
  try {
    const owner = { kind: "project" as const, projectId: "project" };
    const order: ThreadDisplayLayout = {
      pinned: {
        "codex:a": { above: [], below: [] },
        "codex:b": { above: [], below: ["codex:c"] },
      },
    };
    repository.replace(owner, 2, order);
    const loaded = repository.read(owner)!;
    assert.deepEqual(loaded, { revision: 2, displayOrder: order });
    const entries = ["a", "b", "c", "d"].map((id) => ({ key: `codex:${id}`, section: "pinned" as const }));
    assert.deepEqual(
      moveThreadDisplayLayoutItem(entries, loaded.displayOrder, "pinned", "codex:d", null, "codex:b"),
      moveThreadDisplayLayoutItem(entries, order, "pinned", "codex:d", null, "codex:b"),
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("folders retain array and member order while project and global layout owners remain separate", () => {
  const { database, repository } = fixture();
  try {
    const owner = { kind: "project" as const, projectId: "project" };
    const first = randomUUID();
    const second = randomUUID();
    const order: ThreadDisplayLayout = {
      folders: [
        { folderId: second, title: "second", section: "pinned", threadKeys: ["codex:b", "codex:a"] },
        { folderId: first, title: "first", section: "snoozed", threadKeys: ["codex:c"] },
      ],
    };
    repository.replace(owner, 1, order);
    const key = getProjectQualifiedThreadDisplayKey("project", "codex:d");
    const home: ThreadDisplayLayout = { pinned: { [key]: { above: [], below: [] } } };
    repository.replace({ kind: "home" }, 4, home);
    assert.deepEqual(repository.read(owner)?.displayOrder, order);
    assert.deepEqual(repository.read({ kind: "home" }), { revision: 4, displayOrder: home });
    repository.replace(owner, 2, { folders: [...order.folders!].reverse() });
    assert.deepEqual(repository.read(owner)?.displayOrder.folders, [...order.folders!].reverse());
    assert.deepEqual(repository.read({ kind: "home" })?.displayOrder, home);
  } finally {
    database.close();
  }
});

test("invalid layout replacement and outer transaction failure retain the complete previous layout", () => {
  const { database, repository } = fixture();
  try {
    const owner = { kind: "project" as const, projectId: "project" };
    const original: ThreadDisplayLayout = { pinned: { "codex:a": { above: [], below: ["codex:b"] } } };
    repository.replace(owner, 1, original);
    assert.throws(() => repository.replace(owner, 2, {
      pinned: { "codex:a": { above: [], below: ["codex:b"] } },
      snoozed: { "codex:b": { above: [], below: [] } },
    }), /multiple sections/);
    assert.deepEqual(repository.read(owner), { revision: 1, displayOrder: original });
    assert.throws(database.transaction(() => {
      repository.replace(owner, 2, {});
      throw new Error("outer failure");
    }), /outer failure/);
    assert.deepEqual(repository.read(owner), { revision: 1, displayOrder: original });
  } finally {
    database.close();
  }
});
