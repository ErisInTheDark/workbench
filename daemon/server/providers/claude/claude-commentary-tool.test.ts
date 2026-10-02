/* No production exports. Tests protect streamed commentary decoding: every fragment split yields a growing exact prefix. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readStreamedCommentaryText } from "./claude-commentary-tool";

const sentinel = "<set-state mode=\"Inspect\" />\nSENTINEL_7f2c9a\nquotes: \"\\\"'`\"\nunicode: λ → ★ \u{1F600}\nline-a\r\nline-b\t/";
const asciiEscaped = (json: string) => json.replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

function assertGrowingPrefixes(json: string, expected: string) {
  let previous = "";
  for (let end = 0; end <= json.length; end += 1) {
    const decoded = readStreamedCommentaryText(json.slice(0, end));
    assert.ok(decoded.startsWith(previous), `prefix shrank at ${end}`);
    assert.ok(expected.startsWith(decoded), `wrong text at ${end}`);
    const last = decoded.charCodeAt(decoded.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `lone high surrogate emitted at ${end}`);
    previous = decoded;
  }
  assert.equal(previous, expected);
}

test("any fragment split decodes a growing prefix that ends at the exact authored text", () => {
  const raw = JSON.stringify({ text: sentinel });
  assertGrowingPrefixes(raw, sentinel);
  assertGrowingPrefixes(asciiEscaped(raw), sentinel);
});

test("other input keys before text are skipped without leaking their values", () => {
  const json = `{ "other": {"a": [1, "}\\"]"], "b": null}, "n": -3.5e2, "flag": true, "text" : "hi \\u03bb" }`;
  assertGrowingPrefixes(json, "hi λ");
  assert.equal(readStreamedCommentaryText(json.slice(0, json.indexOf("\"text\""))), "");
});
