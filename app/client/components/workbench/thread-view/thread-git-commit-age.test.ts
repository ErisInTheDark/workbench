/*
 * No production exports. Tests protect local-calendar commit age buckets and their group order.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getCommitAgeBucket, groupCommitsByAge } from "./thread-git-commit-age";

const local = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).toISOString();

test("a Monday's yesterday stays yesterday even though it belongs to last week", () => {
  const monday = new Date(2026, 9, 12, 9);
  assert.equal(getCommitAgeBucket(local(2026, 10, 12, 0), monday), "today");
  assert.equal(getCommitAgeBucket(local(2026, 10, 11, 23), monday), "yesterday");
  assert.equal(getCommitAgeBucket(local(2026, 10, 10), monday), "month");
});

test("week and month buckets start at local Monday and the first of the month", () => {
  const saturday = new Date(2026, 9, 17, 21);
  assert.equal(getCommitAgeBucket(local(2026, 10, 16), saturday), "yesterday");
  assert.equal(getCommitAgeBucket(local(2026, 10, 12, 0), saturday), "week");
  assert.equal(getCommitAgeBucket(local(2026, 10, 11, 23), saturday), "month");
  assert.equal(getCommitAgeBucket(local(2026, 10, 1, 0), saturday), "month");
  assert.equal(getCommitAgeBucket(local(2026, 9, 30, 23), saturday), "older");
});

test("unknown times are older commits and groups run oldest first without empty buckets", () => {
  const now = new Date(2026, 9, 17, 21);
  const commits = [
    { id: "today", at: local(2026, 10, 17, 8) },
    { id: "untimed", at: undefined },
    { id: "yesterday", at: local(2026, 10, 16) },
    { id: "september", at: local(2026, 9, 2) },
  ];
  assert.deepEqual(
    groupCommitsByAge(commits, ({ at }) => at, now).map(({ bucket, entries }) => [bucket, entries.map(({ id }) => id)]),
    [
      ["older", ["untimed", "september"]],
      ["yesterday", ["yesterday"]],
      ["today", ["today"]],
    ],
  );
});
