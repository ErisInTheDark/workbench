/*
 * No exports. Tests protect how wb todo argv resolves to list, add, and remove requests for the managed caller.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkbenchAgentCliCommand } from "../cli/workbench-agent-cli-commands";

const agent = { callerHarness: "codex", callerThreadId: "thread-1", cwd: "C:/project", workbenchOrigin: null };
const caller = { cwd: "C:/project", harness: "codex", threadId: "thread-1" };
const body = async (argv: string[]) => {
  const parsed = await parseWorkbenchAgentCliCommand(argv, agent);
  return parsed.kind === "request" ? parsed.request.body : parsed.kind;
};

test("bare wb todo lists, and text adds an optional todo unless --required", async () => {
  assert.deepEqual(await body(["todo"]), { action: "list", ...caller });
  assert.deepEqual(await body(["todo", "--", "tidy", "the", "manifest"]), { action: "add", text: "tidy the manifest", required: false, ...caller });
  assert.deepEqual(await body(["todo", "--required", "fix", "-v", "flag"]), { action: "add", text: "fix -v flag", required: true, ...caller });
  assert.deepEqual(await body(["todo", "--", "remove", "the", "shim"]), { action: "add", text: "remove the shim", required: false, ...caller });
});

test("wb todo remove takes ids, with or without #", async () => {
  assert.deepEqual(await body(["todo", "remove", "--", "3", "#12"]), { action: "remove", ids: [3, 12], ...caller });
});

test("contradictory flags, flags without text, and non-numeric ids are rejected", async () => {
  for (const argv of [["todo", "--required", "--optional", "--", "x"], ["todo", "--required"], ["todo", "remove", "--", "three"], ["todo", "remove"]]) {
    assert.equal(await body(argv), "error", argv.join(" "));
  }
});
