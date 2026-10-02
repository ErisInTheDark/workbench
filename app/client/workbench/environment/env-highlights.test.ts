/* No production exports. Protect dotenv token ranges, reference splitting and missing store keys. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenizeEnv } from "./env-highlights.ts";

function show(text: string, known: ReadonlySet<string> | null) {
  return tokenizeEnv(text, known).map(token => `${token.kind}:${text.slice(token.start, token.end)}`);
}

test("assignments, comments and quoted values become ordered tokens", () => {
  const text = "# note\nexport API=plain # trailing\nNAME=\"quoted ${wb:have} tail\"\n";
  assert.deepEqual(show(text, new Set(["have"])), [
    "comment:# note",
    "export:export ", "key:API", "operator:=", "comment:# trailing",
    "key:NAME", "operator:=", "string:\"quoted ", "reference:${wb:have}", "string: tail\"",
  ]);
});

test("only wb references to keys absent from a loaded store are marked missing", () => {
  const text = "A=${wb:gone} ${vault:any} ${wb:have}";
  assert.deepEqual(show(text, new Set(["have"])).slice(2), ["missing-reference:${wb:gone}", "reference:${vault:any}", "reference:${wb:have}"]);
  assert.deepEqual(show(text, null).slice(2), ["reference:${wb:gone}", "reference:${vault:any}", "reference:${wb:have}"]);
});

test("multiline quoted values stay strings until they close", () => {
  const text = "KEY=\"line one\n# not a comment\nend\"\nNEXT=1";
  assert.deepEqual(show(text, null), [
    "key:KEY", "operator:=", "string:\"line one", "string:# not a comment", "string:end\"", "key:NEXT", "operator:=",
  ]);
});
