/*
 * Keywords: title, history, reuse, dismissal.
 * No exports. Tests protect distinct recency, stable observations, dismissal, and bounded projection.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { currentThreadTitleName, dismissThreadTitle, previousThreadTitles, recordThreadTitle } from "./thread-title-history";

test("reusing a title updates its last use without losing older distinct titles", () => {
  let history = recordThreadTitle([], "", "alpha", 10);
  let current = "alpha";
  for (const [index, title] of ["beta", "gamma", "delta", "epsilon", "zeta", "eta", "beta"].entries()) {
    history = recordThreadTitle(history, current, title, 20 + index);
    current = title;
  }
  assert.equal(history.length, 7);
  assert.deepEqual(history.find((entry) => entry.title === "beta"), { title: "beta", usedAt: 26 });
  assert.deepEqual(previousThreadTitles(history, current).map((entry) => entry.title), ["eta", "zeta", "epsilon", "delta"]);
  assert.deepEqual(recordThreadTitle(history, current, current, 100), history);
});

test("dismissal reveals older history and only a new use restores the dismissed title", () => {
  let history = ["one", "two", "three", "four", "five", "six"].reduce(
    (entries, title, index, titles) => recordThreadTitle(entries, titles[index - 1] ?? "", title, index),
    [] as Array<{ title: string; usedAt: number }>,
  );
  history = dismissThreadTitle(history, "six", "five");
  assert.deepEqual(previousThreadTitles(history, "six").map((entry) => entry.title), ["four", "three", "two", "one"]);
  assert.deepEqual(dismissThreadTitle(history, "six", "six"), history);
  assert.deepEqual(recordThreadTitle(history, "six", "six", 20), history);
  history = recordThreadTitle(history, "six", "five", 30);
  assert.deepEqual(history[0], { title: "five", usedAt: 30 });
  assert.equal(history.filter((entry) => entry.title === "five").length, 1);
});

test("first explicit observation does not import the outgoing display fallback", () => {
  const history = recordThreadTitle([], "first message preview", "new", 10);
  assert.deepEqual(history, [{ title: "new", usedAt: 10 }]);
  assert.deepEqual(recordThreadTitle(history, "new", "", 20), history);
});

test("current thread title is the most recently recorded explicit name", () => {
  assert.equal(currentThreadTitleName([]), null);
  assert.equal(currentThreadTitleName([
    { title: "older", usedAt: 10 },
    { title: "newest", usedAt: 30 },
    { title: "middle", usedAt: 20 },
  ]), "newest");
});

test("the newest recorded title keeps a strictly higher use time under equal or backwards clocks", () => {
  let history = recordThreadTitle([], "", "alpha", 10);
  history = recordThreadTitle(history, "alpha", "zeta", 10);
  assert.equal(currentThreadTitleName(history), "zeta");
  assert.ok(history.find((entry) => entry.title === "zeta")!.usedAt > history.find((entry) => entry.title === "alpha")!.usedAt);
  history = recordThreadTitle(history, "zeta", "beta", 5);
  assert.equal(currentThreadTitleName(history), "beta");
});
