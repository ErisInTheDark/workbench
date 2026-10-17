/*
 * No exports. Wards for the comment syntax agents read and write: authors are optional, glued comments form one thread,
 * unedited comments keep their exact source and no body can end its comment early.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatComment, parseCommentLine, readCommentRun } from "./comment-markdown";

test("glued comments read as one thread; spaced ones end it", () => {
  const run = readCommentRun("<!-- [Chiri V]: why? --><!-- because --> <!-- other -->", 0);
  assert.deepEqual(run?.comments.map(({ author, body }) => ({ author, body })), [
    { author: "Chiri V", body: "why?" },
    { author: null, body: "because" },
  ]);
  assert.equal(run?.end, "<!-- [Chiri V]: why? --><!-- because -->".length);
});

test("older @author comments keep their author", () => {
  assert.deepEqual(readCommentRun("<!-- @lily: hi -->", 0)?.comments.map(({ author, body }) => ({ author, body })),
    [{ author: "lily", body: "hi" }]);
});

test("an author can never break out of its brackets", () => {
  const written = formatComment({ author: "a]: b\nc", body: "note" });
  assert.deepEqual(readCommentRun(written, 0)?.comments.map(({ author, body }) => ({ author, body })),
    [{ author: "a : b c", body: "note" }]);
});

test("a comment line holds only comments", () => {
  assert.equal(parseCommentLine("<!-- a --> <!-- b -->")?.length, 2);
  assert.equal(parseCommentLine("<!-- a --> text"), null);
  assert.equal(parseCommentLine("text <!-- a -->"), null);
});

test("unedited comments keep their source and edited ones use the canonical form", () => {
  const [comment] = readCommentRun("<!--@lily:  odd   spacing-->", 0)!.comments;
  assert.equal(formatComment(comment!), "<!--@lily:  odd   spacing-->");
  assert.equal(formatComment({ ...comment!, body: "fixed" }), "<!-- [lily]: fixed -->");
});

test("a body cannot close its comment early", () => {
  const written = formatComment({ author: null, body: "a --> b" });
  assert.deepEqual(readCommentRun(written, 0)?.end, written.length);
});
