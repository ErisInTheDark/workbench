/*
 * No exports. Tests protect query parsing, folded matching, and that painted ranges land on the raw text that matched.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TextSearch } from "./text-search.ts";

const matches = (query: string, text: string) => TextSearch.matches(TextSearch.parse(query), TextSearch.fold(text));
const painted = (query: string, text: string) => TextSearch.ranges(TextSearch.parse(query), text).map(([start, end]) => text.slice(start, end));

test("every word must appear, in any order and field position", () => {
  assert.equal(matches("cache stale", "The stale read came from the cache"), true);
  assert.equal(matches("cache stale", "The cache was fine"), false);
  assert.equal(TextSearch.isActive(TextSearch.parse("   ")), false);
});

test("matching ignores case, accents, and whitespace shape", () => {
  assert.equal(matches("CAFE", "the café broke"), true);
  assert.equal(matches("\"tool call\"", "a Tool\n  Call failed"), true);
});

test("quoted phrases stay whole and a leading dash excludes", () => {
  assert.equal(matches("\"stale cache\"", "the cache was stale"), false);
  assert.equal(matches("\"stale cache\"", "a stale cache"), true);
  assert.equal(matches("cache -stale", "a stale cache"), false);
  assert.equal(matches("cache -\"stale cache\"", "the cache was stale"), true);
  assert.equal(matches("re-render", "it re-renders twice"), true);
  assert.equal(matches("-", "a - b"), true);
});

test("painted ranges cover the raw matched text, merged where terms overlap", () => {
  assert.deepEqual(painted("cafe", "Le Café et le CAFE"), ["Café", "CAFE"]);
  assert.deepEqual(painted("stale ale", "stale"), ["stale"]);
  assert.deepEqual(painted("\"tool call\"", "a Tool\n  Call"), ["Tool\n  Call"]);
  assert.deepEqual(painted("-cache", "cache"), []);
});
