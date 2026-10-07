/*
 * No production exports. Tests the daemon spawns the pinned Codex dependency's native binary.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import resolveCodexExecutable from "./codex-executable";

test("the resolved Codex binary is the pinned dependency's version", async () => {
  const pinned = (require("../package.json") as { dependencies: Record<string, string> }).dependencies["@openai/codex"];
  const { stdout } = await promisify(execFile)(resolveCodexExecutable(), ["--version"], { windowsHide: true });
  assert.equal(stdout.trim(), `codex-cli ${pinned}`);
});
