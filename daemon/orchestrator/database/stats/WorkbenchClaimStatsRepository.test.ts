/*
 * No exports. Tests protect distinct managed claimants, missing metadata, and bounded historical queries.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchStatsRepository from "./WorkbenchStatsRepository.ts";
import WorkbenchClaimStatsRepository from "./WorkbenchClaimStatsRepository.ts";
import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository.ts";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  NativeThreadId: {
    "native": fixtureIdentitySchemas.NativeThreadIdSchema.parse("native"),
  },
  ProjectId: {
    "empty": fixtureIdentitySchemas.ProjectIdSchema.parse("empty"),
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
};

const now = Date.UTC(2026, 8, 4, 12);
const day = 86_400_000;

test("one Workbench claimant counts once across native providers and pending metadata", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(db);
    const identities = new WorkbenchThreadIdentityRepository(db);
    const identity = identities.observe({
      native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId: fixtureIdentityValues.NativeThreadId["native"] },
      projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project", title: "one owner", createdAt: now, updatedAt: now, activityAt: now,
    });
    const writer = new WorkbenchStatsRepository(db);
    for (const [harness, threadId] of [["codex", "native"], ["codex", identity.threadId], ["opencode", identity.threadId]] as const) {
      writer.recordClaimSnapshot({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), threadId, harness, observedAt: now, roots: [{ rootId: "root", paths: ["file"] }] });
    }
    const repository = new WorkbenchClaimStatsRepository(db);
    assert.equal(repository.hotspots("project", now - day, now)[0]?.threadCount, 1);
    const result = repository.read({ projectId: fixtureIdentityValues.ProjectId["project"], range: "7d", page: 1, file: { rootId: "root", path: "file" } }, now);
    assert.equal(result.rows.length, 1);
    assert.equal(result.kind === "threads" && result.rows[0]?.threadId, identity.threadId);
  } finally { db.close(); }
});

test("claim identities coalesce providers and days into managed threads without dropping missing titles", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(db);
    const managed = new WorkbenchThreadIdentityRepository(db).observe({
      native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId: fixtureIdentityValues.NativeThreadId["native"] },
      projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project", title: "Current title", createdAt: now, updatedAt: now, activityAt: now,
    }).threadId;
    const writer = new WorkbenchStatsRepository(db);
    for (const [threadId, harness, observedAt] of [
      ["native", "codex", now - day], [managed, "codex", now],
      ["missing", "codex", now],
    ] as const) writer.recordClaimSnapshot({
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), threadId, harness, observedAt, roots: [{ rootId: "root", paths: ["src/file.ts"] }],
    });
    const repository = new WorkbenchClaimStatsRepository(db);
    const request = { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), range: "7d" as const, page: 1 };
    const files = repository.read({ ...request, file: null }, now);
    assert.equal(files.kind, "files");
    assert.deepEqual(files.rows, [{ rootId: "root", path: "src/file.ts", threadCount: 2 }]);
    const threads = repository.read({ ...request, file: { rootId: "root", path: "src/file.ts" } }, now);
    assert.equal(threads.kind, "threads");
    if (threads.kind !== "threads") return;
    assert.equal(threads.rows.length, 2);
    assert.deepEqual(threads.rows.map(({ threadId, title, identity }) => ({ threadId, title, identity })).sort((a, b) => a.threadId.localeCompare(b.threadId)), [
      { threadId: managed, title: "Current title", identity: "managed" },
      { threadId: "missing", title: null, identity: "provider" },
    ].sort((a, b) => a.threadId.localeCompare(b.threadId)));
    assert.equal(repository.hotspots("project", now - 6 * day, now)[0]?.threadCount, 2);
  } finally { db.close(); }
});

test("claim queries isolate roots and projects, preserve historical days, and page without repeats", () => {
  const db = new Database(":memory:");
  try {
    installWorkbenchDatabaseSchema(db);
    const writer = new WorkbenchStatsRepository(db);
    for (let index = 0; index < 53; index += 1) writer.recordClaimSnapshot({
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), threadId: `thread-${String(index).padStart(2, "0")}`, harness: "codex",
      observedAt: now, roots: [{ rootId: "root", paths: [`file-${String(index).padStart(2, "0")}`, "shared"] }],
    });
    for (const [projectId, rootId, observedAt] of [
      ["other", "root", now], ["project", "secondary", now], ["project", "root", now - 8 * day],
    ] as const) writer.recordClaimSnapshot({
      projectId, threadId: "outside", harness: "codex", observedAt, roots: [{ rootId, paths: ["shared"] }],
    });
    const repository = new WorkbenchClaimStatsRepository(db);
    const request = { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), range: "7d" as const, page: 1, file: null };
    const first = repository.read(request, now);
    const second = repository.read({ ...request, page: 2 }, now);
    assert.equal(first.pages, 2);
    assert.equal(first.rows.length, 50);
    assert.equal(second.rows.length, 5);
    if (first.kind !== "files" || second.kind !== "files") return assert.fail("expected file results");
    assert.equal(new Set([...first.rows, ...second.rows].map((row) => `${row.rootId}:${row.path}`)).size, 55);
    const fileRequest = { ...request, file: { rootId: "root", path: "shared" } };
    const threadPages = [repository.read(fileRequest, now), repository.read({ ...fileRequest, page: 2 }, now)];
    const ids = threadPages.flatMap((result) => result.kind === "threads" ? result.rows.map((row) => row.threadId) : []);
    assert.equal(ids.length, 53);
    assert.equal(new Set(ids).size, 53);
    const historical = repository.read({ ...fileRequest, range: "all", page: 2 }, now);
    assert.equal(historical.rows.length, 4);
    assert.deepEqual(repository.read({ ...request, projectId: fixtureIdentityValues.ProjectId["empty"] }, now).rows, []);
  } finally { db.close(); }
});

test("retained transcript identities supply titles only when native identity is unambiguous", () => {
  const db = new Database(":memory:");
  try {
    installWorkbenchDatabaseSchema(db);
    const transcript = new WorkbenchTranscriptRepository(db);
    for (const [threadId, nativeThreadId] of [["canonical", "native"], ["one", "ambiguous"], ["two", "ambiguous"]] as const) {
      transcript.settle([{
        kind: "thread", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), title: `Title ${threadId}`, projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project",
        createdAt: now, updatedAt: now, activityAt: now,
      }, {
        kind: "turn", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(threadId), turnIndex: 0, nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(nativeThreadId), nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(threadId),
        harnessId: "codex", nativeLocation: "C:/project", state: "completed", createdAt: now,
        startedAt: now, endedAt: now + 1, durationMs: 1,
      }]);
    }
    const writer = new WorkbenchStatsRepository(db);
    for (const threadId of ["native", "canonical", "ambiguous"]) writer.recordClaimSnapshot({
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), threadId, harness: "codex", observedAt: now,
      roots: [{ rootId: "root", paths: ["src/file.ts"] }],
    });
    const result = new WorkbenchClaimStatsRepository(db).read({
      projectId: fixtureIdentityValues.ProjectId["project"], range: "7d", page: 1, file: { rootId: "root", path: "src/file.ts" },
    }, now);
    assert.equal(result.kind, "threads");
    if (result.kind !== "threads") return;
    const canonical = new WorkbenchThreadIdentityRepository(db).resolve({ threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse("canonical") })!.threadId;
    assert.deepEqual(result.rows.map(({ threadId, title, identity }) => ({ threadId, title, identity })), [
      { threadId: "ambiguous", title: null, identity: "provider" },
      { threadId: canonical, title: "Title canonical", identity: "managed" },
    ]);
  } finally { db.close(); }
});
