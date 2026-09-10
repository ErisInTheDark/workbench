/*
 * No production exports. Protect layout round trips and subsequent interaction semantics.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  getProjectQualifiedThreadDisplayKey, getThreadDisplayThreadKey, moveThreadDisplayLayoutItem, type ThreadDisplayLayout,
} from "workbench-shared/workbench/thread/thread-display-layout";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadStateLayoutRepository from "./WorkbenchThreadStateLayoutRepository";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
};

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const identities = new WorkbenchThreadIdentityRepository(database);
  const references = ["a", "b", "c", "d"].map((nativeThreadId) => identities.observe({
    native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(nativeThreadId) },
    projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project", title: nativeThreadId,
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
      return { projectId: reference.projectId, harness: "codex", threadId: reference.threadId };
    },
  });
  const keys = references.map(reference => getThreadDisplayThreadKey("codex", reference.threadId));
  return { database, repository, keys };
}

test("layout reload preserves explicit empty positions, implied references and future move behaviour", () => {
  const { database, repository, keys: [a, b, c, d] } = fixture();
  try {
    const owner = { kind: "project" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") };
    const order: ThreadDisplayLayout = {
      pinned: {
        "codex:a": { above: [], below: [] },
        "codex:b": { above: [], below: ["codex:c"] },
      },
    };
    repository.replace(owner, 2, order);
    const loaded = repository.read(owner)!;
    const expected: ThreadDisplayLayout = { pinned: {
      [a]: { above: [], below: [] },
      [b]: { above: [], below: [c] },
    } };
    assert.deepEqual(loaded, { revision: 2, displayOrder: expected });
    const entries = [a, b, c, d].map(key => ({ key, section: "pinned" as const }));
    assert.deepEqual(
      moveThreadDisplayLayoutItem(entries, loaded.displayOrder, "pinned", d, null, b),
      moveThreadDisplayLayoutItem(entries, expected, "pinned", d, null, b),
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("folders retain array and member order while project and global layout owners remain separate", () => {
  const { database, repository, keys: [a, b, c, d] } = fixture();
  try {
    const owner = { kind: "project" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") };
    const first = fixtureIdentitySchemas.FolderIdSchema.parse(randomUUID());
    const second = fixtureIdentitySchemas.FolderIdSchema.parse(randomUUID());
    const order: ThreadDisplayLayout = {
      folders: [
        { folderId: second, title: "second", section: "pinned", threadKeys: ["codex:b", "codex:a"] },
        { folderId: first, title: "first", section: "snoozed", threadKeys: ["codex:c"] },
      ],
    };
    repository.replace(owner, 1, order);
    const expected: ThreadDisplayLayout = { folders: [
      { folderId: second, title: "second", section: "pinned", threadKeys: [b, a] },
      { folderId: first, title: "first", section: "snoozed", threadKeys: [c] },
    ] };
    const key = getProjectQualifiedThreadDisplayKey(fixtureIdentityValues.ProjectId["project"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:d"));
    const home: ThreadDisplayLayout = { pinned: { [key]: { above: [], below: [] } } };
    repository.replace({ kind: "home" }, 4, home);
    const canonicalKey = getProjectQualifiedThreadDisplayKey(fixtureIdentityValues.ProjectId.project, d);
    const expectedHome: ThreadDisplayLayout = { pinned: { [canonicalKey]: { above: [], below: [] } } };
    assert.deepEqual(repository.read(owner)?.displayOrder, expected);
    assert.deepEqual(repository.read({ kind: "home" }), { revision: 4, displayOrder: expectedHome });
    repository.replace(owner, 2, { folders: [...order.folders!].reverse() });
    assert.deepEqual(repository.read(owner)?.displayOrder.folders, [...expected.folders!].reverse());
    assert.deepEqual(repository.read({ kind: "home" })?.displayOrder, expectedHome);
  } finally {
    database.close();
  }
});

test("invalid layout replacement and outer transaction failure retain the complete previous layout", () => {
  const { database, repository, keys: [a, b] } = fixture();
  try {
    const owner = { kind: "project" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") };
    const original: ThreadDisplayLayout = { pinned: { "codex:a": { above: [], below: ["codex:b"] } } };
    repository.replace(owner, 1, original);
    const expected: ThreadDisplayLayout = { pinned: { [a]: { above: [], below: [b] } } };
    assert.throws(() => repository.replace(owner, 2, {
      pinned: { "codex:a": { above: [], below: ["codex:b"] } },
      snoozed: { "codex:b": { above: [], below: [] } },
    }), /multiple sections/);
    assert.deepEqual(repository.read(owner), { revision: 1, displayOrder: expected });
    assert.throws(database.transaction(() => {
      repository.replace(owner, 2, {});
      throw new Error("outer failure");
    }), /outer failure/);
    assert.deepEqual(repository.read(owner), { revision: 1, displayOrder: expected });
  } finally {
    database.close();
  }
});
