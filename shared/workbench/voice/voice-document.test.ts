/* Exports: none. Protect text/selection round trips and reject ambiguous model output. */
import assert from "node:assert/strict";
import test from "node:test";
import { decodeVoiceDocument, encodeVoiceDocument } from "./voice-document";

test("caret and selections preserve multiline Unicode and literal marker text", () => {
  const text = 'first\n\ud83d\ude80 <caret /> &lt; <selection>literal</selection>\nlast';
  for (const selection of [{ start: 0, end: 0 }, { start: 6, end: 8 }, { start: 9, end: 30 }, { start: text.length, end: text.length }]) {
    assert.deepEqual(decodeVoiceDocument(encodeVoiceDocument(text, selection)), { text, selection });
  }
});
test("insertion and replacement return the edited text and new caret", () => {
  assert.deepEqual(decodeVoiceDocument("before inserted<caret /> after"), {
    text: "before inserted after", selection: { start: 15, end: 15 },
  });
  assert.deepEqual(decodeVoiceDocument("a <selection>replacement</selection> z"), {
    text: "a replacement z", selection: { start: 2, end: 13 },
  });
});
test("malformed metadata is never admitted as document content", () => {
  for (const value of ["plain", "<caret /><caret />", "<selection>x", "<caret /><selection>x</selection>", "<selection><selection>x</selection></selection>", "a &oops; <caret />"]) {
    assert.throws(() => decodeVoiceDocument(value));
  }
  assert.throws(() => encodeVoiceDocument("a", { start: 0, end: 2 }));
});
