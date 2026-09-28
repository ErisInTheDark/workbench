/*
 * No exports. Protect explicit paid consent before a provider scenario reaches the trusted daemon.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseThreadTestArguments } from "./thread-test-arguments";

test("thread scenario requires one provider and explicit paid mode", () => {
  assert.equal(parseThreadTestArguments(["--codex", "--paid"]), "codex");
  assert.equal(parseThreadTestArguments(["--opencode", "--paid"]), "opencode");
  assert.equal(parseThreadTestArguments(["--", "--codex", "--paid"]), "codex");
  for (const args of [
    ["--codex"], ["--opencode"], ["--codex", "--fake"], ["--fake", "--paid"],
    ["--codex", "--opencode", "--paid"], ["--codex", "--paid", "--paid"],
    ["--codex", "--", "--paid"],
  ]) assert.throws(() => parseThreadTestArguments(args));
});
