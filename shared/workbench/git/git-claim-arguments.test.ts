/*
 * Keywords: git, claims, CLI operands, literal paths.
 * Exports: none. Protect operation prefixes without interpreting MCP-style literal paths.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseGitClaimArguments, parseGitClaimOperands } from "./git-claim-arguments";
import { applyGitClaimChanges } from "./git-arc-state";

test("claim refusals retain typed reasons and affected paths", () => {
  assert.throws(() => parseGitClaimArguments(["--", "new.ts"], false), (error) => {
    assert.ok(error instanceof Error && "rejection" in error);
    assert.deepEqual(error.rejection, { reason: "inheritanceRequired" });
    return true;
  });
  assert.throws(() => applyGitClaimChanges(["kept.ts"], { inherit: true, removePaths: ["missing.ts"] }), (error) => {
    assert.ok(error instanceof Error && "rejection" in error);
    assert.deepEqual(error.rejection, { reason: "unclaimedRemoval", paths: ["missing.ts"] });
    return true;
  });
});

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
