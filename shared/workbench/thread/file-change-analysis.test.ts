/* No production exports. Keywords: patch, partial writes, ambiguity, newline, moves. */
import assert from "node:assert/strict";
import test from "node:test";
import type { FileUpdateChange } from "../../codex/generated/app-server/v2/FileUpdateChange.ts";
import { analyseFileChange, type FileObservation } from "./file-change-analysis.ts";

function update(diff: string, text: string) {
  return analyseFileChange(
    { diff, kind: { type: "update", move_path: null }, path: "file" },
    new Map([["file", { kind: "file", text }]]),
  );
}

test("partial writes count only requested changes already present", () => {
  const diff = "@@ -1,3 +1,3 @@\n start\n-before\n+after\n end\n@@ -6,3 +6,3 @@\n next\n-old\n+new\n finish\n";
  const result = update(diff, "start\nafter\nend\n\n\nnext\nold\nfinish\n");
  assert.equal(result.outcome, "partial");
  assert.deepEqual(result.hunks.map(({ outcome }) => outcome), ["present", "unapplied"]);
  assert.deepEqual([result.additions, result.deletions], [1, 1]);
  assert.equal(update(diff, "start\nafter\nend\n\n\nnext\nnew\nfinish\n").outcome, "present");
  assert.equal(update(diff, "start\nbefore\nend\n\n\nnext\nold\nfinish\n").outcome, "unapplied");
});

test("contextual insertion and deletion discard only contained weaker matches", () => {
  const insertion = "@@ -1,2 +1,3 @@\n left\n+inserted\n right\n";
  assert.equal(update(insertion, "left\ninserted\nright\n").outcome, "present");
  assert.equal(update(insertion, "left\nright\n").outcome, "unapplied");
  const prefixInsertion = "@@ -1 +1,2 @@\n+inserted\n anchor\n";
  assert.equal(update(prefixInsertion, "inserted\nanchor\n").outcome, "present");
  const deletion = "@@ -1,2 +1 @@\n-removed\n anchor\n";
  assert.equal(update(deletion, "removed\nanchor\n").outcome, "unapplied");
  assert.equal(update(deletion, "anchor\n").outcome, "present");
});

test("repeated, conflicting and reordered matches cannot prove a patch applied", () => {
  const diff = "@@ -1,2 +1,2 @@\n anchor\n-old\n+new\n";
  assert.equal(update(diff, "anchor\nnew\nanchor\nnew\n").outcome, "uncertain");
  assert.equal(update(diff, "anchor\nnew\nanchor\nold\n").outcome, "uncertain");
  assert.equal(update(diff, "unrelated\nnew\n").outcome, "uncertain");
  const ordered = diff + "@@ -4,2 +4,2 @@\n second\n-before\n+after\n";
  assert.equal(update(ordered, "second\nafter\nanchor\nnew\n").outcome, "uncertain");
  assert.equal(update(diff + diff, "anchor\nnew\n").outcome, "uncertain");
});

test("CRLF matches while missing final newline remains meaningful", () => {
  const diff = "@@ -1 +1 @@\n-old\n+new\n";
  assert.equal(update(diff, "new\r\n").outcome, "present");
  assert.equal(update(diff, "new").outcome, "uncertain");
  assert.equal(update(diff + "\\ No newline at end of file\n", "new").outcome, "present");
  assert.equal(update(diff + "\\ No newline at end of file\n", "new\nextra\n").outcome, "uncertain");
});

test("incomplete or unnumbered hunks never manufacture success", () => {
  assert.equal(update("@@ -1,2 +1,2 @@\n-old\n+new\n", "new\n").outcome, "uncertain");
  assert.equal(update("@@\n-old\n+new\n", "new\n").outcome, "uncertain");
  assert.equal(update("@@ -0 +0 @@\n-old\n+new\n", "new\n").outcome, "uncertain");
});

test("whole additions, deletions and both move paths have distinct evidence", () => {
  const file = (text: string): FileObservation => ({ kind: "file", text });
  const missing: FileObservation = { kind: "missing" };
  const analyse = (change: FileUpdateChange, source: FileObservation, destination: FileObservation = missing) => analyseFileChange(
    change, new Map([["file", source], ["destination", destination]]),
  );
  const add: FileUpdateChange = { path: "file", kind: { type: "add" }, diff: "new\n" };
  assert.equal(analyse(add, file("new\n")).outcome, "present");
  assert.equal(analyse(add, missing).outcome, "unapplied");
  assert.equal(analyse(add, file("new\nextra\n")).outcome, "uncertain");
  const remove: FileUpdateChange = { path: "file", kind: { type: "delete" }, diff: "old\n" };
  assert.equal(analyse(remove, missing).outcome, "present");
  assert.equal(analyse(remove, file("old\n")).outcome, "unapplied");
  const move: FileUpdateChange = {
    path: "file", kind: { type: "update", move_path: "destination" },
    diff: "@@ -1,2 +1,2 @@\n anchor\n-old\n+new\n",
  };
  assert.equal(analyse(move, missing, file("anchor\nnew\n")).outcome, "present");
  assert.equal(analyse(move, file("anchor\nold\n"), file("anchor\nnew\n")).outcome, "copied");
  assert.equal(analyse(move, file("anchor\nold\n")).outcome, "unapplied");
  assert.equal(analyse({ ...move, diff: `${move.diff}\n\nMoved to: destination` }, missing, file("anchor\nnew\n")).outcome, "present");
  assert.equal(analyse(move, missing).outcome, "uncertain");
  assert.equal(analyse(add, { kind: "unavailable", reason: "Read denied." }).outcome, "uncertain");
});
