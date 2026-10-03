/*
 * No production exports. Tests protect mention completion and caret-local suggestion eligibility.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInlineMentionCandidates,
  buildInlineMentionHighlights,
  buildInlineMentionSuggestions,
} from "./inline-mention-highlights";

const sources = buildInlineMentionCandidates({
  files: ["app/widget.ts", "app/my widget.ts", "left/shared.ts", "right/shared.ts"],
  skills: [{
    description: "Use for iteration.",
    name: "iterate",
    path: "C:/skills/iterate/SKILL.md",
    relativePath: "skills/iterate/SKILL.md",
  }],
});

test("completion produces a bracketed file reference and ends suggestions for both mention kinds", () => {
  for (const [input, path] of [
    ["#wid", "app/widget.ts"],
    ["#[app/my", "app/my widget.ts"],
    ["/iter", "C:/skills/iterate/SKILL.md"],
  ]) {
    const suggestion = buildInlineMentionSuggestions(input, input.length, sources)
      .find((suggestion) => suggestion.candidate.path === path);
    assert.ok(suggestion);
    const completed = input.slice(0, suggestion.start) + suggestion.replacementText + input.slice(suggestion.end);
    if (suggestion.candidate.kind === "file") {
      assert.ok(completed.startsWith("#[") && completed.endsWith("]"));
    }
    assert.equal(buildInlineMentionHighlights(completed, sources)[0]?.path, path);
    assert.deepEqual(buildInlineMentionSuggestions(completed, completed.length, sources), []);
  }
});

test("resolved mentions suppress suggestions throughout their highlighted range", () => {
  for (const mention of ["/iterate", "#app/widget.ts", "#[app/widget.ts]", "#[app/widget.ts:12]", "#[app/my widget.ts]"]) {
    const text = `please use ${mention} next`;
    const [highlight] = buildInlineMentionHighlights(text, sources);
    assert.ok(highlight, mention);
    for (let caret = highlight.start + 1; caret <= highlight.end; caret += 1) {
      assert.deepEqual(buildInlineMentionSuggestions(text, caret, sources), [], `${mention} at ${caret}`);
    }
  }
});

test("unfinished and ambiguous mentions still offer completion outside earlier resolved mentions", () => {
  for (const text of ["/iter", "#wid", "#[app/my", "#shared.ts", "/iterate /iter", "#[app/widget.ts] #wid"]) {
    assert.ok(buildInlineMentionSuggestions(text, text.length, sources).length > 0, text);
  }
  assert.deepEqual(buildInlineMentionSuggestions("/iterate ", 9, sources), []);
});
