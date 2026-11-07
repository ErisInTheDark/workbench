/* No production exports. Tests protect send-time tool markup checks and the code regions they leave alone. */
import assert from "node:assert/strict";
import test from "node:test";
import { findWorkbenchToolReferenceProblems, replaceWorkbenchToolReferences } from "./tool-reference-markup";

const known = new Set(["git_arc_status", "git_arc_release"]);

test("well-formed references to known tools pass", () => {
  assert.deepEqual(findWorkbenchToolReferenceProblems(
    "run <tool id=\"git_arc_status\" /> then <tool id=\"git_arc_release\" args='{\"fromPlan\":true}'/>", known,
  ), []);
});

test("unknown and harness-prefixed ids are rejected, prefixed ones with their bare id", () => {
  const problems = findWorkbenchToolReferenceProblems(
    "<tool id=\"git_arc_stat\" /> <tool id=\"mcp__wb__git_arc_status\" /> <tool id=\"wbex_git_arc_release\" />", known,
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0] ?? "", /git_arc_stat"/u);
  assert.match(problems[1] ?? "", /use "git_arc_status"/u);
  assert.match(problems[2] ?? "", /use "git_arc_release"/u);
});

test("markup that does not parse is rejected", () => {
  for (const text of [
    "<tool id=\"git_arc_status\">",
    "<tool name=\"git_arc_status\" />",
    "<tool id=\"git_arc_status\" args=\"{}\" />",
    "<tool id='git_arc_status' />",
  ]) assert.equal(findWorkbenchToolReferenceProblems(text, known).length, 1, text);
});

test("args must be one JSON object", () => {
  for (const args of ["[1]", "null", "{oops}", "3"]) {
    assert.equal(findWorkbenchToolReferenceProblems(`<tool id="git_arc_status" args='${args}' />`, known).length, 1, args);
  }
});

test("markup inside inline code and fenced blocks is example text", () => {
  const text = "write `<tool id=\"nope\" />` like\n```md\n<tool id=\"nope\" /> <tool broken\n```\ndone";
  assert.deepEqual(findWorkbenchToolReferenceProblems(text, known), []);
  assert.equal(replaceWorkbenchToolReferences(text, () => "X"), text);
});

test("replacement renders each parsed reference and leaves unrendered or malformed markup as written", () => {
  const text = "a <tool id=\"git_arc_status\" args='{\"full\":[\"dirty\"]}' /> b <tool id=\"other\" /> c <tool oops>";
  assert.equal(
    replaceWorkbenchToolReferences(text, ({ id, args }) => id === "other" ? null : `[${id} ${args}]`),
    "a [git_arc_status {\"full\":[\"dirty\"]}] b <tool id=\"other\" /> c <tool oops>",
  );
});
