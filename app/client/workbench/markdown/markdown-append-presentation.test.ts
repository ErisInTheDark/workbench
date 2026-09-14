/*
 * No production exports. Pure semantic regressions protect fail-closed Markdown append classification. Keywords: markdown, append, AST, suffix.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { deriveMarkdownAppendPresentation } from "./markdown-append-presentation";

function derive(previousMarkdown: string | null, nextMarkdown: string, reducedMotion = false) {
  return deriveMarkdownAppendPresentation({ nextMarkdown, previousMarkdown, reducedMotion });
}

test("isolates compatible final text and wholly new inline or block suffixes", () => {
  assert.deepEqual(derive("Hello", "Hello world"), {
    kind: "append",
    target: { blockIndex: 0, kind: "text", nodePath: [0], prefixLength: 5, revisionKey: "5:11" },
  });
  assert.deepEqual(derive("Hello **there**", "Hello **there** friend"), {
    kind: "append",
    target: { blockIndex: 0, kind: "inlineTail", revisionKey: "15:22", startNodeIndex: 2 },
  });
  assert.deepEqual(derive("First", "First\n\nSecond"), {
    kind: "append",
    target: { blockIndex: 1, kind: "inlineTail", revisionKey: "5:13", startNodeIndex: 0 },
  });
});

test("fails closed for semantic, structural, divergent, and reduced-motion updates", () => {
  for (const [previousMarkdown, nextMarkdown] of [
    ["**bold", "**bold**"],
    ["[link](https://a", "[link](https://a.example)"],
    ["```ts\nconst value = 1;", "```ts\nconst value = 1;\n```"],
    ["- one", "- one\n- two"],
    ["<set-state mode=\"Brief\"", "<set-state mode=\"Brief\" />"],
    ["Hello", "Goodbye"],
    ["Hello world", "Hello"],
  ]) {
    assert.deepEqual(derive(previousMarkdown, nextMarkdown), { kind: "instant" });
  }
  assert.deepEqual(derive("Hello", "Hello world", true), { kind: "instant" });
  assert.deepEqual(derive(null, "Hello"), { kind: "instant" });
});
