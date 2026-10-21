/*
 * No production exports. Tests protect query grammar, name match ordering, typo corrections, coverage-first scoring and excerpts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSearchName,
  matchSearchName,
  parseSearchQuery,
  rankSearchCandidate,
  searchCorrections,
  searchExcerpt,
} from "./workbench-search-ranking";

const word = (query: string) => parseSearchQuery(query)[0]!;
const name = (text: string, initials = false) => [createSearchName(text, { initials })];

test("queries keep words, exact phrases and exclusions distinct, folding case and accents", () => {
  assert.deepEqual(parseSearchQuery('Café "Two Words" -gamma -"not these" SearchDialog'), [
    { excluded: false, kind: "word", tokens: ["cafe"], value: "cafe" },
    { excluded: false, kind: "phrase", tokens: ["two", "words"], value: "two words" },
    { excluded: true, kind: "word", tokens: ["gamma"], value: "gamma" },
    { excluded: true, kind: "phrase", tokens: ["not", "these"], value: "not these" },
    { excluded: false, kind: "word", tokens: ["search", "dialog"], value: "searchdialog" },
  ]);
  assert.deepEqual(parseSearchQuery('"unfinished phrase'), [
    { excluded: false, kind: "phrase", tokens: ["unfinished", "phrase"], value: "unfinished phrase" },
  ]);
});

test("whole words beat joined words, then prefixes, initials and inner fragments", () => {
  const exact = matchSearchName(word("search"), name("Improve search results"));
  const prefix = matchSearchName(word("sear"), name("Improve search results"));
  const joined = matchSearchName(word("searchdialog"), name("WorkbenchSearchDialog.tsx"));
  const inner = matchSearchName(word("chdia"), name("WorkbenchSearchDialog.tsx"));
  const initials = matchSearchName(word("wsd"), name("WorkbenchSearchDialog.tsx", true));
  assert.equal(exact, 1);
  assert.ok(exact > joined && joined > prefix && prefix > initials && initials > inner && inner > 0);
  assert.equal(matchSearchName(word("wsd"), name("WorkbenchSearchDialog.tsx")), 0, "initials only count where a name opts in");
});

test("multi-part words and phrases need their parts in order, and weights scale name evidence", () => {
  assert.equal(matchSearchName(word("SearchDialog"), name("open the search dialog")), 1);
  assert.ok(matchSearchName(word("SearchDialog"), name("dialog for search")) < 1);
  assert.equal(matchSearchName(parseSearchQuery('"dialog search"')[0]!, name("search dialog")), 0);
  assert.equal(matchSearchName(word("search"), [createSearchName("src/search", { weight: 0.7 })]), 0.7);
});

test("typos only match through corrections, which stay close, prefer common spellings and skip short or odd words", () => {
  assert.equal(matchSearchName(word("serch"), name("search dialog")), 0);
  assert.ok(matchSearchName(word("serch"), name("search dialog"), new Set(["search"])) > 0);
  const vocabulary = [{ frequency: 2, term: "starch" }, { frequency: 40, term: "search" }, { frequency: 5, term: "perch" }, { frequency: 9, term: "sketch" }];
  assert.deepEqual(searchCorrections("serch", vocabulary), ["search", "perch"]);
  assert.deepEqual(searchCorrections("sea", vocabulary), []);
  assert.deepEqual(searchCorrections("asdlfkajsdlfkjasdlfkjasdf", vocabulary), []);
  assert.deepEqual(searchCorrections("c0de", [{ frequency: 1, term: "code" }]), []);
});

test("covering more of the query outranks any quality, phrases are required, and landing together lifts a match", () => {
  const query = parseSearchQuery("loader animation");
  const strongPartial = rankSearchCandidate(query, [{ body: 0, name: 1 }, { body: 0, name: 0 }]);
  const weakComplete = rankSearchCandidate(query, [{ body: 0.2, name: 0 }, { body: 0.2, name: 0 }]);
  assert.ok(weakComplete! > strongPartial!);
  const apart = rankSearchCandidate(query, [{ body: 0.6, name: 0 }, { body: 0.6, name: 0 }]);
  const together = rankSearchCandidate(query, [{ body: 0.6, name: 0 }, { body: 0.6, name: 0 }], { together: 0.8 });
  assert.ok(together! > apart!);
  assert.ok(rankSearchCandidate(query, [{ body: 0.6, name: 0 }, { body: 0.6, name: 0 }], { lift: 1.4 })! > apart!);
  assert.equal(rankSearchCandidate(parseSearchQuery('loader "exact phrase"'), [{ body: 0, name: 1 }, { body: 0, name: 0 }]), null);
  assert.equal(rankSearchCandidate(query, [{ body: 0, name: 0 }, { body: 0, name: 0 }]), null);
});

test("excerpts centre on the first matched needle and mark trimmed ends", () => {
  const text = `${"lead in ".repeat(60)}the needle sits here ${"trailing ".repeat(60)}`;
  const excerpt = searchExcerpt(text, ["absent", "needle"], 80);
  assert.match(excerpt, /^\.\.\. .*needle sits here.* \.\.\.$/u);
  assert.equal(searchExcerpt("  short\n text ", ["short"]), "short text");
  for (const word of excerpt.replace(/^\.\.\. | \.\.\.$/gu, "").split(" ")) {
    assert.ok(["lead", "in", "the", "needle", "sits", "here", "trailing"].includes(word), `whole words only, got "${word}"`);
  }
});

test("excerpts read as prose, without markdown or markup syntax", () => {
  assert.equal(
    searchExcerpt('<icon type="x">**bold** `code` in #[src/file.ts:12]</icon> <br/>done', ["bold"]),
    "bold code in src/file.ts:12 done",
  );
  assert.equal(
    searchExcerpt("## Findings\n- see [the docs](https://x.y)\n\n| time | event |\n|---|---|\n| 0s | start |", ["start"]),
    "Findings see the docs time · event 0s · start",
  );
});
