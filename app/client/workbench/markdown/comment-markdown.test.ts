/*
 * No exports. Wards for the comment syntax agents read and write: authors are optional, glued comments form one thread,
 * unedited comments keep their exact source and no body can end its comment early.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatComment, parseCommentLine, readCommentRun } from "./comment-markdown";

test("glued comments read as one thread; spaced ones end it", () => {
  const run = readCommentRun("<!-- @chiri: why? --><!-- because --> <!-- other -->", 0);
  assert.deepEqual(run?.comments.map(({ author, body }) => ({ author, body })), [
    { author: "chiri", body: "why?" },
    { author: null, body: "because" },
  ]);
  assert.equal(run?.end, "<!-- @chiri: why? --><!-- because -->".length);
});

test("a comment line holds only comments", () => {
  assert.equal(parseCommentLine("<!-- a --> <!-- b -->")?.length, 2);
  assert.equal(parseCommentLine("<!-- a --> text"), null);
  assert.equal(parseCommentLine("text <!-- a -->"), null);
});

test("unedited comments keep their source and edited ones use the canonical form", () => {
  const [comment] = readCommentRun("<!--@lily:  odd   spacing-->", 0)!.comments;
  assert.equal(formatComment(comment!), "<!--@lily:  odd   spacing-->");
  assert.equal(formatComment({ ...comment!, body: "fixed" }), "<!-- @lily: fixed -->");
});

test("a body cannot close its comment early", () => {
  const written = formatComment({ author: null, body: "a --> b" });
  assert.deepEqual(readCommentRun(written, 0)?.end, written.length);
});
