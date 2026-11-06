/* No production exports. Tests untrusted token measuring stays off the event loop when long runs are many, and bounds that work. */
import assert from "node:assert/strict";
import { test } from "node:test";

import Gpt5TextTokens from "./gpt-5-text-tokens";
import { Gpt5TokenDeadlineError, measureGpt5Tokens } from "./gpt-5-token-measure";

const diverseCjk = (length: number) => Array.from({ length }, (_, index) => String.fromCodePoint(0x4e00 + (index * 7919) % 20000)).join("");

test("ordinary text measures in order without a worker", async () => {
  const measures = await measureGpt5Tokens(["hello world", "a little more text"], { deadlineMs: 0 });
  assert.deepEqual(measures, [Gpt5TextTokens.measure("hello world"), Gpt5TextTokens.measure("a little more text")]);
});

test("text full of long runs measures on a worker while the event loop keeps turning", async () => {
  const text = diverseCjk(60_000);
  let turns = 0;
  const ticking = setInterval(() => { turns += 1; }, 5);
  try {
    const [measure] = await measureGpt5Tokens([text]);
    assert.equal(measure!.estimated, true);
    assert.ok(measure!.tokens > 60_000);
    assert.ok(turns > 5, `the event loop only turned ${turns} times`);
  } finally {
    clearInterval(ticking);
  }
});

test("a worker past its deadline, or whose caller left, is given up on", async () => {
  const text = "x".repeat(5_000);
  await assert.rejects(measureGpt5Tokens([text], { deadlineMs: 1 }), Gpt5TokenDeadlineError);
  const caller = new AbortController();
  const measuring = measureGpt5Tokens([text], { signal: caller.signal });
  caller.abort(new Error("left"));
  await assert.rejects(measuring, /left/u);
});
