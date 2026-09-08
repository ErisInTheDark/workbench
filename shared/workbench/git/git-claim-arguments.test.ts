/*
 * Keywords: git, claims, CLI operands, literal paths.
 * Exports: none. Protect operation prefixes without interpreting MCP-style literal paths.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseGitClaimOperands } from "./git-claim-arguments";

test("claim operands distinguish operations from literal prefixed filenames", () => {
  assert.deepEqual(parseGitClaimOperands(["new.ts", "-old.ts", "*dirty.ts", "./-literal", "./*literal"]), {
    addPaths: ["new.ts", "./-literal", "./*literal"],
    removePaths: ["old.ts"],
    adoptPaths: ["dirty.ts"],
  });
});

test("claim operands reject empty operation targets rather than claiming the repository", () => {
  for (const operand of ["-", "*", ""]) {
    assert.throws(() => parseGitClaimOperands([operand]));
  }
});
