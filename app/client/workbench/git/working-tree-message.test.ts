/* No production exports. Protect subject overflow and existing description text. */
import assert from "node:assert/strict";
import test from "node:test";
import { editWorkingTreeMessage } from "./working-tree-message";

test("overflow moves intact words ahead of existing description and positions the caret", () => {
  const prefix = "keep the working tree review responsive while switching between";
  const result = editWorkingTreeMessage(`${prefix} different files`, "existing notes");
  assert.equal(result.title, `${prefix}\u2026`);
  assert.equal(result.description, "\u2026different files\n\nexisting notes");
  assert.equal(result.focusOffset, "\u2026different files".length);
});

test("continued overflow joins the existing continuation without duplicating words", () => {
  const prefix = "keep the working tree review responsive while switching between";
  const result = editWorkingTreeMessage(`${prefix} additional changes\u2026`, "\u2026changed files\n\nnotes");
  assert.equal(result.title, `${prefix}\u2026`);
  assert.equal(result.description, "\u2026additional changes changed files\n\nnotes");
});

test("multiline input keeps the first line as subject and moves remaining lines before notes", () => {
  const result = editWorkingTreeMessage("short subject\r\nfirst detail\r\nsecond detail", "notes");
  assert.equal(result.title, "short subject");
  assert.equal(result.description, "first detail\nsecond detail\n\nnotes");
  assert.equal(result.focusOffset, "first detail\nsecond detail".length);
});

test("unbroken Unicode overflow preserves characters and stays within the subject budget", () => {
  const input = "\u{1f431}".repeat(80);
  const result = editWorkingTreeMessage(input, "");
  assert.ok(Array.from(result.title).length <= 72);
  assert.equal(result.title.replace(/\u2026$/u, "") + result.description.replace(/^\u2026/u, ""), input);
});

test("short edits do not rewrite the description or steal focus", () => {
  assert.deepEqual(editWorkingTreeMessage("short", "notes"), { title: "short", description: "notes", focusOffset: null });
});
