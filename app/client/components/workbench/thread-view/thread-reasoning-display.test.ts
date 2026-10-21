/*
 * No production exports. Tests protect reasoning step order, exact disclosure omission, and the code-aware live sentence. Keywords: reasoning, live, disclosure, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  getLatestReasoningSentence,
  getThreadReasoningSteps,
  omitThreadReasoningStep,
  projectThreadReasoningMarkdown,
} from "./thread-reasoning-display";

type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;

function reasoning(summary: string[]): ReasoningItem {
  return { content: ["hidden raw reasoning"], id: "reasoning", summary, type: "reasoning" };
}

test("reasoning sections preserve order and split each title from its description", () => {
  assert.deepEqual(getThreadReasoningSteps([reasoning([
    "## First title\n\nFirst description.",
    "**Second title**\nSecond description.",
    "  ",
  ])]), [
    {
      body: "First description.",
      itemId: "reasoning",
      markdown: "## First title\n\nFirst description.",
      sectionIndex: 0,
      source: "summary",
      title: "First title",
    },
    {
      body: "Second description.",
      itemId: "reasoning",
      markdown: "**Second title**\nSecond description.",
      sectionIndex: 1,
      source: "summary",
      title: "Second title",
    },
  ]);
});

test("omitting a step removes only that exact section", () => {
  const item = reasoning(["First\nold detail", "Latest\nlive detail"]);
  assert.deepEqual(
    omitThreadReasoningStep(item, { itemId: "reasoning", sectionIndex: 1, source: "summary" }),
    reasoning(["First\nold detail"]),
  );
});

test("presented reasoning Markdown keeps title and body projection identical to settled steps", () => {
  assert.deepEqual(projectThreadReasoningMarkdown("## Streaming title\n\nStreaming body."), {
    body: "Streaming body.",
    title: "Streaming title",
  });
});

test("title-only reasoning becomes one bodyless step and exact omission removes the item", () => {
  const item = reasoning(["Reason carefully"]);
  const [step] = getThreadReasoningSteps([item]);
  assert.equal(step?.title, "Reason carefully");
  assert.equal(step?.body, null);
  assert.equal(omitThreadReasoningStep(item, {
    itemId: "reasoning",
    sectionIndex: 0,
    source: "summary",
  }), null);
});

test("live reasoning reads as the first sentence of its newest prose paragraph", () => {
  assert.equal(getLatestReasoningSentence("Old idea. More.\n\nNew plan here. Then more detail."), "New plan here.");
  assert.equal(getLatestReasoningSentence("## Checking the cache\n\n**Bold lead** is next! after"), "Bold lead is next!");
  assert.equal(getLatestReasoningSentence("Still writing the first line\nwith a second"), "Still writing the first line");
});

test("code blocks in reasoning never become the sentence or split the prose around them", () => {
  const closed = "Reading the runtime. It owns state.\n\n```rust\nfn a() {}\n\nfn b() {}\n```";
  assert.equal(getLatestReasoningSentence(closed), "Reading the runtime.");
  assert.equal(getLatestReasoningSentence("Patch the loader. Then test.\n\n~~~ts\nconst a = 1;\n\nconst b = 2;"), "Patch the loader.");
  assert.equal(getLatestReasoningSentence("```\nonly code\n```"), null);
});

test("punctuation inside inline code does not end the sentence", () => {
  assert.equal(
    getLatestReasoningSentence("Read `src/script/runtime.rs`, `dts.rs` and `a.b!` next. Later."),
    "Read `src/script/runtime.rs`, `dts.rs` and `a.b!` next.",
  );
});
