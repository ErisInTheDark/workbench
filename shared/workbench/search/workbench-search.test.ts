/*
 * No production exports. Tests protect workspace-search grammar, fuzzy matching, exclusions, and field weighting. Keywords: search, fuzzy, ranking, query.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseWorkbenchSearchQuery,
  rankWorkbenchSearchFields,
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
