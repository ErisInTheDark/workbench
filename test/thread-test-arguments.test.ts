/*
 * No exports. Protect explicit per-provider mode consent before a scenario reaches the trusted daemon.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseThreadTestArguments } from "./thread-test-arguments";

test("thread scenario requires explicit provider modes", () => {
  assert.deepEqual(parseThreadTestArguments(["--codex=paid"]), { codex: "paid" });
  assert.deepEqual(parseThreadTestArguments(["--opencode=fake"]), { opencode: "fake" });
  assert.deepEqual(parseThreadTestArguments(["--claude=fake"]), { claude: "fake" });
  assert.deepEqual(parseThreadTestArguments(["--", "--codex=paid", "--opencode=fake"]), {
    codex: "paid", opencode: "fake",
  });
  assert.deepEqual(parseThreadTestArguments(["--opencode=paid", "--codex=fake"]), {
    codex: "fake", opencode: "paid",
  });
  for (const args of [
    [], ["--codex"], ["--opencode"], ["--codex", "--paid"],
    ["--codex=free"], ["--codex=paid", "--codex=fake"],
    ["--codex=paid", "--opencode=fake", "--codex=fake"],
    ["--codex=paid", "--", "--opencode=fake"], ["--other=fake"],
  ]) assert.throws(() => parseThreadTestArguments(args));
});
