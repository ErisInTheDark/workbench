/*
 * Keywords: title, history, reuse, dismissal.
 * No exports. Tests protect distinct recency, stable observations, dismissal, and bounded projection.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dismissThreadTitle, previousThreadTitles, recordThreadTitle } from "./thread-title-history";

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

test("first observation keeps the known prior title without inventing its historical age", () => {
  const history = recordThreadTitle([], "old", "new", 10);
  assert.deepEqual(history, [{ title: "new", usedAt: 10 }, { title: "old", usedAt: 10 }]);
  assert.deepEqual(recordThreadTitle(history, "new", "", 20), history);
});
