/* No production exports. Reporter wards preserve failures, bounded owned noise, slow-test order, pass suppression, skip counts, and the final summary. Keywords: tests, reporter, output, noise, slow. */
import assert from "node:assert/strict";
import test from "node:test";

import conciseTestReporter from "./concise-test-reporter.mjs";

async function render(events: Array<{ data: Record<string, unknown>; type: string }>) {
  async function* source() {
    for (const event of events) yield event;
  }
  let output = "";
  for await (const chunk of conciseTestReporter(source())) output += chunk;
  return output;
}

test("emits failures, owned noise, sorted slow tests, skips, and one summary without passing chatter", async () => {
  const file = "reporter-owner.test.ts";
  const output = await render([
    { type: "test:start", data: { file, name: "slow passing ward" } },
    { type: "test:stderr", data: { file, message: "diagnostic detail\n" } },
    { type: "test:pass", data: { details: { duration_ms: 1_200 }, file, name: "slow passing ward" } },
    { type: "test:pass", data: { details: { duration_ms: 2 }, file, name: "quiet passing ward" } },
    { type: "test:pass", data: { details: { duration_ms: 1 }, file, name: "skipped ward", skip: "platform" } },
    { type: "test:fail", data: { details: { duration_ms: 2_400, error: new Error("boom") }, file, name: "slower failing ward" } },
  ]);

  assert.match(output, /FAILURES \(1\)[\s\S]*?slower failing ward[\s\S]*?boom/u);
  assert.match(output, /STDERR reporter-owner\.test\.ts :: slow passing ward[\s\S]*?diagnostic detail/u);
  assert.ok(output.indexOf("2400.0ms") < output.indexOf("1200.0ms"));
  assert.doesNotMatch(output, /quiet passing ward/u);
  assert.match(output, /Tests: 4 \| Pass: 2 \| Fail: 1 \| Skip: 1/u);
});

test("bounds individual and total process noise", async () => {
  const output = await render([8_000, 4_000, 4_000, 4_000, 4_000].map((length) => ({
    type: "test:stdout",
    data: { file: "noisy.test.ts", message: "x".repeat(length) },
  })));

  assert.match(output, /\[truncated 4000 characters\]/u);
  assert.match(output, /\[omitted 1 additional noise entry totaling 4000 characters after 16000 retained characters\]/u);
  assert.ok(output.length < 18_000);
});

test("bounds failure details while preserving their head and stack tail", async () => {
  const error = new Error(`important failure head ${"x".repeat(10_000)} important stack tail`);
  const output = await render([{ type: "test:fail", data: { details: { error }, file: "huge-failure.test.ts", name: "huge failure ward" } }]);

  assert.match(output, /important failure head/u);
  assert.match(output, /important stack tail/u);
  assert.match(output, /\[truncated \d+ failure characters\]/u);
  assert.ok(output.length < 7_000);
});
