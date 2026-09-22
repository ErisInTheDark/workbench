/*
 * No production exports. Protect literal-command admission and permission boundaries.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalApprovalWorkdir, COMMAND_APPROVAL_CONFIRMATION, hasApprovalConfirmation, matchesApprovalPrefix, parseApprovalCommand } from "./command-approval-prefix.ts";

test("literal argv and supported shell wrappers preserve exact tokens", () => {
  assert.deepEqual(parseApprovalCommand('pnpm run test -- "two words"'), ["pnpm", "run", "test", "--", "two words"]);
  assert.deepEqual(parseApprovalCommand("bash -lc 'pnpm run test'"), ["pnpm", "run", "test"]);
  assert.deepEqual(parseApprovalCommand('powershell.exe -NoProfile -Command "pnpm test"'), ["pnpm", "test"]);
  assert.deepEqual(parseApprovalCommand('"C:\\Program Files\\nodejs\\npm.cmd" run test'), ["C:\\Program Files\\nodejs\\npm.cmd", "run", "test"]);
  assert.deepEqual(parseApprovalCommand(String.raw`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'pnpm run typecheck'`), ["pnpm", "run", "typecheck"]);
});

test("unsupported shell syntax never becomes a reusable permission", () => {
  for (const command of [
    "pnpm test; echo surprise", "pnpm test && echo surprise", "pnpm test | cat", "pnpm test\nwhoami",
    'pnpm test "$(whoami)"', "pnpm test `whoami`", "pnpm test > output", "pnpm test $ARGS",
    "FOO=bar pnpm test", "pnpm test # comment", "pnpm test *.ts", "pnpm test %PATH%",
    "pnpm test !PATH!", "pnpm test < input", "pnpm test (whoami)", "pnpm test &",
    'bash -lc "pnpm test; whoami"', "bash -c 'pnpm test' extra", "pwsh -EncodedCommand abc",
    "pnpm test 'unterminated", "pnpm test --% ; whoami", "pnpm test \\\nwhoami",
    "pnpm test @arguments", "pnpm test ~/expanded", "pnpm test arg\u2028whoami",
    String.raw`pnpm test arg\\other`, String.raw`pnpm test "C:\\extra"`,
    String.raw`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'pnpm test; whoami'`,
  ]) assert.equal(parseApprovalCommand(command), null, command);
});

test("permission boundaries compare complete tokens and exact canonical directories", () => {
  assert.equal(matchesApprovalPrefix(["pnpm", "test", "--watch"], ["pnpm", "test"]), true);
  assert.equal(matchesApprovalPrefix(["pnpm", "testing"], ["pnpm", "test"]), false);
  assert.equal(matchesApprovalPrefix(["pnpm", "test"], []), false);
  assert.equal(canonicalApprovalWorkdir("C:\\Repo\\sub\\..\\"), canonicalApprovalWorkdir("c:/repo"));
  assert.notEqual(canonicalApprovalWorkdir("/Repo"), canonicalApprovalWorkdir("/repo"));
  assert.notEqual(canonicalApprovalWorkdir("C:/repo/sub"), canonicalApprovalWorkdir("C:/repo"));
  assert.equal(canonicalApprovalWorkdir("../repo"), null);
  assert.equal(canonicalApprovalWorkdir("C:\\"), "c:/");
  assert.equal(canonicalApprovalWorkdir("\\\\host\\share"), canonicalApprovalWorkdir("//host/share"));
});

test("confirmation requires the complete deliberate declaration, not a similar claim", () => {
  assert.equal(hasApprovalConfirmation(`Run the tests.\n${COMMAND_APPROVAL_CONFIRMATION}`), true);
  assert.equal(hasApprovalConfirmation(null), false);
  assert.equal(hasApprovalConfirmation(`Do not say "${COMMAND_APPROVAL_CONFIRMATION}"`), false);
});
