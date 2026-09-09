/*
 * No production exports. Tests protect workspace-search grammar, fuzzy matching, exclusions, and field weighting. Keywords: search, fuzzy, ranking, query.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseWorkbenchSearchQuery,
  rankWorkbenchSearchFields,
  createWorkbenchSearchMatcher,
  type WorkbenchSearchField,
} from "./workbench-search";

test("search query parsing keeps fuzzy words, exact phrases, and negative clauses distinct", () => {
  assert.deepEqual(parseWorkbenchSearchQuery('alpha beta "two words" -gamma -"not these"'), [
    { excluded: false, kind: "word", value: "alpha" },
    { excluded: false, kind: "word", value: "beta" },
    { excluded: false, kind: "phrase", value: "two words" },
    { excluded: true, kind: "word", value: "gamma" },
    { excluded: true, kind: "phrase", value: "not these" },
  ]);
  assert.deepEqual(parseWorkbenchSearchQuery('"unfinished phrase'), [
    { excluded: false, kind: "phrase", value: "unfinished phrase" },
  ]);
});

test("unquoted words fuzzy-match independently across weighted fields", () => {
  const fields: WorkbenchSearchField[] = [
    { kind: "title", text: "Search architecture" },
    { kind: "userMessage", text: "Please support fuzzy matching" },
  ];
  const ranked = rankWorkbenchSearchFields(parseWorkbenchSearchQuery("serch fuzzy"), fields);
  assert.ok(ranked);
  assert.equal(ranked.bestFieldKind, "title");
});

test("quoted phrases are contiguous and negative clauses exclude the whole candidate", () => {
  const fields: WorkbenchSearchField[] = [
    { kind: "title", text: "Alpha exact phrase" },
    { kind: "commentary", text: "A haunted cache remains" },
  ];
  assert.ok(rankWorkbenchSearchFields(parseWorkbenchSearchQuery('"exact phrase"'), fields));
  assert.equal(rankWorkbenchSearchFields(parseWorkbenchSearchQuery('"alpha phrase"'), fields), null);
  assert.equal(rankWorkbenchSearchFields(parseWorkbenchSearchQuery("alpha -cache"), fields), null);
  assert.equal(rankWorkbenchSearchFields(parseWorkbenchSearchQuery('alpha -"haunted cache"'), fields), null);
});

test("title, user, commentary, and file fields keep the requested value order", () => {
  const query = parseWorkbenchSearchQuery("needle");
  const score = (kind: WorkbenchSearchField["kind"]) => (
    rankWorkbenchSearchFields(query, [{ kind, text: "needle" }])?.score ?? 0
  );
  assert.equal(score("title") / score("userMessage"), 2);
  assert.equal(score("userMessage") / score("commentary"), 2);
  assert.equal(score("commentary") / score("filePath"), 2);
});

function referenceWordScore(needle: string, text: string) {
  if (text === needle) return 1;
  if (text.startsWith(needle)) return 0.95;
  if (text.includes(needle)) return 0.9;
  let best = 0;
  for (const word of text.split(/[^\p{L}\p{N}_./\\-]+/u).filter(Boolean)) {
    let previous = Array.from({ length: word.length + 1 }, (_, index) => index);
    for (let i = 1; i <= needle.length; i++) {
      const current = [i];
      for (let j = 1; j <= word.length; j++) {
        current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(needle[i - 1] !== word[j - 1]));
      }
      previous = current;
    }
    const length = Math.max(needle.length, word.length);
    const distance = previous[word.length];
    if (distance <= Math.max(1, Math.floor(length / 3))) best = Math.max(best, 0.75 * (1 - distance / length));
  }
  return best;
}

test("bounded matching preserves edit-distance eligibility and scores at length and edit boundaries", () => {
  const words = ["a", "at", "cat", "search", "searxh", "serch", "sarchx", "architecture", "archtectre", "src/search.ts", "東京検索", "éclair", "asdlfkajsdlfkjasdlfkjasdf"];
  for (const query of words) {
    const matcher = createWorkbenchSearchMatcher(parseWorkbenchSearchQuery(query));
    for (const word of words) {
      const text = `prefix ${word} suffix`;
      const expected = referenceWordScore(query.toLowerCase(), text.toLowerCase());
      const actual = matcher([{ kind: "title", text }]);
      assert.equal(actual?.score ?? 0, expected * 8, `${query} against ${word}`);
      assert.equal(actual === null, expected === 0);
    }
  }
});

test("nonsense does not match ordinary titles or transcript bodies and query scores cannot leak", () => {
  const fields: WorkbenchSearchField[] = [
    { kind: "title", text: "Build the search feature" },
    { kind: "userMessage", text: "Please make requests fast and keep matching relevant." },
    { kind: "commentary", text: "Checking database performance and testing the controller." },
  ];
  const match = createWorkbenchSearchMatcher(parseWorkbenchSearchQuery("asdlfkajsdlfkjasdlfkjasdf"));
  assert.equal(match(fields), null);
  assert.ok(createWorkbenchSearchMatcher(parseWorkbenchSearchQuery("performance"))(fields));
  assert.equal(match(fields), null);
});
