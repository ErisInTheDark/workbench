/* Exports: none. Protect active-turn threshold and hidden rollover-opening contracts. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKBENCH_CONTEXT_ROLLOVER_INSTRUCTION,
  createWorkbenchContextRolloverInput,
  isWorkbenchContextRolloverInput,
  shouldRequestContextRollover,
} from "./thread-context-rollover.ts";

test("rollover threshold uses the selected guarded cap", () => {
  assert.equal(shouldRequestContextRollover(77_999, 128_000), false);
  assert.equal(shouldRequestContextRollover(78_000, 128_000), true);
  assert.equal(shouldRequestContextRollover(500_000, null), false);
});

test("hidden opening preserves the summary verbatim inside one reserved wrapper", () => {
  const summary = "## user messages\nverbatim\n\n## next steps\ncontinue";
  const input = createWorkbenchContextRolloverInput(summary);
  assert.equal(isWorkbenchContextRolloverInput(input), true);
  assert.match(input[0]?.type === "text" ? input[0].text : "", /verbatim[\s\S]*continue/u);
  assert.equal(isWorkbenchContextRolloverInput([
    ...input, { type: "text", text: "visible sibling", text_elements: [] },
  ]), false);
});

test("directive requires the complete handoff before ordinary work", () => {
  for (const phrase of ["relevant user message", "verbatim", "approved plan", "approved addendum", "remaining work", "intended next steps"]) {
    assert.match(WORKBENCH_CONTEXT_ROLLOVER_INSTRUCTION, new RegExp(phrase, "iu"));
  }
});
