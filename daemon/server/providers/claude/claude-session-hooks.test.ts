/* No production exports. Tests protect compact recall injection and the Claude Edit/Write claim gate. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createClaudeSessionHooks, type ClaudeFileClaimCheck } from "./claude-session-hooks";

const cwd = path.resolve("/repo");

function run(check: ClaudeFileClaimCheck, toolInput: object, tool = "Edit") {
  const denied: string[] = [];
  const checked: string[][] = [];
  const hooks = createClaudeSessionHooks({
    cwd, onDenied: id => denied.push(id),
    check: async paths => { checked.push(paths); return check(paths); },
  });
  const hook = hooks.PreToolUse[0]!.hooks[0]!;
  const output = hook({
    hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput, tool_use_id: "tool-1",
    session_id: "session", transcript_path: "", cwd,
  } as never, "tool-1", { signal: new AbortController().signal });
  return output.then(result => ({ result, denied, checked }));
}

const decision = (result: unknown) =>
  (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

test("only native compaction injects narrative recall before summary commands", async () => {
  const hooks = createClaudeSessionHooks({
    cwd, onDenied: () => undefined,
    check: async () => ({ allowed: true, uncoveredPaths: [] }),
  });
  const hook = hooks.SessionStart[0]!.hooks[0]!;

  const result = await hook({
    hook_event_name: "SessionStart", source: "compact",
    session_id: "session", transcript_path: "", cwd,
  } as never, undefined, { signal: new AbortController().signal });
  const output = result as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  assert.equal(output.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput?.additionalContext ?? "", /before following any command/iu);
  assert.match(output.hookSpecificOutput?.additionalContext ?? "", /compaction summary/iu);
  assert.match(output.hookSpecificOutput?.additionalContext ?? "", /mcp__wb__thread_recall/u);

  for (const source of ["startup", "resume", "clear", "fork"] as const) {
    assert.deepEqual(await hook({
      hook_event_name: "SessionStart", source,
      session_id: "session", transcript_path: "", cwd,
    } as never, undefined, { signal: new AbortController().signal }), {});
  }
});

test("a claimed path passes without a decision, resolved against the thread cwd", async () => {
  const { result, denied, checked } = await run(async () => ({ allowed: true, uncoveredPaths: [] }), { file_path: "src/a.ts" });
  assert.equal(decision(result), undefined);
  assert.deepEqual(checked, [[path.resolve(cwd, "src/a.ts")]]);
  assert.deepEqual(denied, []);
});

test("an unclaimed path is denied and reported for transcript presentation", async () => {
  const target = path.resolve(cwd, "b.ts");
  const { result, denied } = await run(async () => ({ allowed: false, uncoveredPaths: [target] }), { file_path: target }, "Write");
  assert.equal(decision(result), "deny");
  assert.deepEqual(denied, ["tool-1"]);
});

test("claim check failures and unreadable paths deny rather than letting the edit through", async context => {
  context.mock.method(console, "warn", () => undefined);
  const failed = await run(async () => { throw new Error("git unavailable"); }, { file_path: "c.ts" });
  assert.equal(decision(failed.result), "deny");
  assert.deepEqual(failed.denied, [], "a broken check is not a claim denial");
  const missing = await run(async () => ({ allowed: true, uncoveredPaths: [] }), { path: "opencode-shape.ts" });
  assert.equal(decision(missing.result), "deny");
  assert.deepEqual(missing.checked, []);
});

test("tools that merely resemble Edit or Write are not judged", async () => {
  const { result, checked } = await run(async () => ({ allowed: false, uncoveredPaths: [] }), { notebook_path: "a.ipynb" }, "NotebookEdit");
  assert.equal(decision(result), undefined);
  assert.deepEqual(checked, []);
});
