/*
 * No exports. Tests protect feedback scope, windows, filters, ordering, paging, single-report reads, resolution and its retention, and thread-independent retention.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import type { WorkbenchFeedbackRecord } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchFeedbackRepository from "./WorkbenchFeedbackRepository.ts";

const day = 86_400_000;
const now = Date.UTC(2026, 9, 7, 12);
const threadId = WorkbenchThreadIdSchema.parse("thread");

function setup() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  for (const projectId of [testProjectIds.project, testProjectIds.other]) {
    database.prepare("INSERT INTO workbench_projects (id) VALUES (?)").run(projectId);
  }
  database.prepare(`
    INSERT INTO workbench_threads (
      id, project_id, project_root, title, archived, pinned, snoozed,
      transcript_content_version, next_turn_index, created_at, updated_at, activity_at
    ) VALUES ('thread', ?, 'C:/project', 'fix stats header', 0, 0, 0, 0, 0, 1, 1, 1)
  `).run(testProjectIds.project);
  return { database, repository: new WorkbenchFeedbackRepository(database) };
}

const report = (overrides: Partial<WorkbenchFeedbackRecord> = {}): WorkbenchFeedbackRecord => ({
  category: "waste", channel: "wb", harness: "codex", model: "claude-opus-5-5", projectId: testProjectIds.project,
  reasoningEffort: "high", report: "diff printed lockfile churn", threadId, title: "Lockfile diff noise", ...overrides,
});

test("schema migration gives retained feedback a reload-compatible placeholder title", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database, { targetVersion: databaseReleases.threadGoals.version });
    database.prepare("INSERT INTO workbench_projects (id) VALUES (?)").run(testProjectIds.project);
    database.prepare("INSERT INTO workbench_harnesses (id) VALUES ('codex')").run();
    database.prepare(`
      INSERT INTO workbench_agent_feedback (
        project_id, harness_id, channel, category, report, created_at
      ) VALUES (?, 'codex', 'wb', 'bug', 'retained report', 1)
    `).run(testProjectIds.project);

    installWorkbenchDatabaseSchema(database);

    const migrated = database.prepare("SELECT title FROM workbench_agent_feedback").get() as { title: string };
    assert.equal(migrated.title, "Feedback report");
  } finally {
    database.close();
  }
});

test("one report reads by id exactly as the stats summary lists it, whatever its age, and not once deleted", () => {
  const { database, repository } = setup();
  try {
    const { id } = repository.record(report({ channel: "project" }), now - 400 * day);
    repository.record(report({ channel: "project", category: "bug" }), now - day);
    const listed = repository.summary(null, 0, now + day).items.find((item) => item.id === id);
    assert.deepEqual(repository.report(id), {
      counts: [{ category: "waste", count: 1 }], items: [listed], ownership: [], resolved: [], total: 1, workbenchProjectId: null,
    });
    repository.delete([id]);
    assert.deepEqual(repository.report(id), { counts: [], items: [], ownership: [], resolved: [], total: 0, workbenchProjectId: null });
  } finally {
    database.close();
  }
});

test("stats summaries count only the selected projects and period, most important first", () => {
  const { database, repository } = setup();
  try {
    const project = (overrides: Partial<WorkbenchFeedbackRecord> = {}) => report({ channel: "project", ...overrides });
    repository.record(project({ model: "gpt-5.4-nano", reasoningEffort: "none" }), now - day);
    repository.record(project({ category: "confusion", model: "unlisted-model" }), now - 2 * day);
    repository.record(project(), now - 3 * day);
    repository.record(project({ projectId: testProjectIds.other }), now - day);
    repository.record(project(), now - 30 * day);

    const summary = repository.summary([testProjectIds.project], now - 7 * day, now + 1);
    assert.equal(summary.total, 3);
    assert.deepEqual(summary.counts, [{ category: "waste", count: 2 }, { category: "confusion", count: 1 }]);
    const importance = summary.items.map((item) => item.importance);
    assert.deepEqual(importance, [...importance].sort((left, right) => right - left));
    assert.equal(summary.items[0]?.model, "claude-opus-5-5");
    assert.equal(summary.items[0]?.title, "Lockfile diff noise");
    assert.equal(summary.items.find(({ model }) => model === "unlisted-model")?.scored, false);

    assert.equal(repository.summary(null, now - 7 * day, now + 1).total, 4);
    assert.equal(repository.summary([testProjectIds.project], now - 2 * day, now - day).total, 1);
  } finally {
    database.close();
  }
});

test("wb reports belong to the Workbench project whichever project filed them", () => {
  const { database, repository } = setup();
  try {
    repository.record(report({ projectId: testProjectIds.other }), now);
    repository.record(report({ channel: "project", projectId: testProjectIds.other }), now);
    const workbench = testProjectIds.project;
    assert.equal(repository.summary([workbench], 0, now + 1, workbench).total, 1);
    assert.equal(repository.summary([testProjectIds.other], 0, now + 1, workbench).items[0]?.channel, "project");
    assert.equal(repository.summary([testProjectIds.other], 0, now + 1, workbench).total, 1);
    assert.equal(repository.summary(null, 0, now + 1, workbench).total, 2);
    assert.equal(repository.summary(null, 0, now + 1, null).total, 1);
  } finally {
    database.close();
  }
});

test("agent reads filter by channel and category and page within bounds", () => {
  const { database, repository } = setup();
  try {
    for (let index = 0; index < 25; index += 1) repository.record(report(), now - index * 60_000);
    repository.record(report({ channel: "project" }), now);
    repository.record(report({ category: "bug", projectId: testProjectIds.other }), now);
    const request = { category: "waste", channel: "wb", page: 1, projectIds: [testProjectIds.project], range: "7d", sort: "newest" } as const;
    const first = repository.read(request, now);
    assert.equal(first.pages, 2);
    assert.equal(first.rows.length, 20);
    assert.ok(first.rows.every((row) => row.channel === "wb" && row.category === "waste"));
    assert.equal(repository.read({ ...request, page: 2 }, now).rows.length, 5);
    assert.equal(repository.read({ ...request, page: 3 }, now).rows.length, 0);
    assert.equal(repository.read({ ...request, category: null, projectIds: null }, now).pages, 2);
    assert.equal(repository.read({ ...request, category: "bug", projectIds: null }, now).rows[0]?.projectId, testProjectIds.other);
  } finally {
    database.close();
  }
});

test("deleting feedback removes only the given reports", () => {
  const { database, repository } = setup();
  try {
    const kept = repository.record(report(), now).id;
    const removed = [repository.record(report(), now).id, repository.record(report({ category: "bug" }), now).id];
    assert.equal(repository.delete([...removed, 999]), 2);
    assert.deepEqual(repository.summary(null, 0, now + 1, testProjectIds.project).items.map(({ id }) => id), [kept]);
    assert.equal(repository.delete([]), 0);
  } finally {
    database.close();
  }
});

test("resolved reports leave the open summary and agent reads, list by latest resolution whatever the period, and reopen", () => {
  const { database, repository } = setup();
  try {
    const open = repository.record(report(), now - day).id;
    const old = repository.record(report({ category: "bug" }), now - 90 * day).id;
    const recent = repository.record(report(), now - 2 * day).id;
    assert.equal(repository.setResolved([old], true, now - 3 * day), 1);
    assert.equal(repository.setResolved([recent, old], true, now - day), 1, "re-resolving keeps the first resolution");

    const summary = repository.summary([testProjectIds.project], now - 7 * day, now + 1, testProjectIds.project, now);
    assert.deepEqual([summary.total, summary.items.map(({ id }) => id)], [1, [open]]);
    assert.deepEqual(summary.counts, [{ category: "waste", count: 1 }]);
    assert.deepEqual(summary.resolved.map(({ id, resolvedAt }) => [id, resolvedAt]), [[recent, now - day], [old, now - 3 * day]]);
    const agentRows = repository.read({ category: null, channel: null, page: 1, projectIds: null, range: "all", sort: "newest" }, now).rows;
    assert.deepEqual(agentRows.map(({ id }) => id), [open]);

    assert.equal(repository.setResolved([recent], false, now), 1);
    const reopened = repository.summary([testProjectIds.project], now - 7 * day, now + 1, testProjectIds.project, now);
    assert.deepEqual(reopened.items.map(({ id, resolvedAt }) => [id, resolvedAt]).sort(), [[open, null], [recent, null]].sort());
    assert.deepEqual(reopened.resolved.map(({ id }) => id), [old]);
  } finally {
    database.close();
  }
});

test("resolved reports disappear once their resolution leaves the retention window, and retention deletes them", () => {
  const { database, repository } = setup();
  try {
    const project = report({ channel: "project" });
    const kept = repository.record(project, now - 30 * day).id;
    const expired = repository.record(project, now - 30 * day).id;
    const open = repository.record(project, now - 30 * day).id;
    repository.setResolved([kept], true, now - 6 * day);
    repository.setResolved([expired], true, now - 8 * day);

    assert.deepEqual(repository.summary(null, 0, now + 1, null, now).resolved.map(({ id }) => id), [kept]);
    assert.equal(repository.expireResolved(now), 1);
    assert.equal(repository.report(expired).total, 0);
    assert.equal(repository.report(kept).items[0]?.resolvedAt, now - 6 * day);
    assert.equal(repository.report(open).total, 1);
  } finally {
    database.close();
  }
});

test("feedback outlives its thread and rejects empty reports", () => {
  const { database, repository } = setup();
  try {
    repository.record(report(), now);
    database.prepare("DELETE FROM workbench_threads WHERE id = 'thread'").run();
    const [row] = repository.summary(null, 0, now + 1, testProjectIds.project).items;
    assert.equal(row?.threadId, null);
    assert.equal(row?.report, "diff printed lockfile churn");
    assert.throws(() => repository.record(report({ report: "" }), now), /CHECK/u);
  } finally {
    database.close();
  }
});

test("stats summaries expose scoped compound ownership from addressed threads", () => {
  const { database, repository } = setup();
  try {
    const first = repository.record(report(), now).id;
    const old = repository.record(report(), now - 30 * day).id;
    const insert = database.prepare(`
      INSERT INTO workbench_thread_addressed_feedback
        (thread_id, source_daemon_id, feedback_id, position, category, title, author, thread_label, report, created_at)
      VALUES ('thread', ?, ?, ?, 'bug', 'title', 'author', 'source', 'report', ?)
    `);
    insert.run("daemon-a", first, 0, now);
    insert.run("daemon-b", first, 1, now);
    insert.run("daemon-a", old, 2, now - 30 * day);

    assert.deepEqual(repository.summary([testProjectIds.project], now - 7 * day, now + 1).ownership, [
      { daemonId: "daemon-a", id: first },
      { daemonId: "daemon-b", id: first },
    ]);
    assert.deepEqual(repository.summary([testProjectIds.other], now - 7 * day, now + 1).ownership, []);

    database.prepare("DELETE FROM workbench_thread_addressed_feedback WHERE thread_id = 'thread'").run();
    assert.deepEqual(repository.summary(null, 0, now + 1).ownership, []);
    insert.run("daemon-a", first, 0, now);
    database.prepare("DELETE FROM workbench_threads WHERE id = 'thread'").run();
    assert.deepEqual(repository.summary(null, 0, now + 1).ownership, []);
  } finally {
    database.close();
  }
});
