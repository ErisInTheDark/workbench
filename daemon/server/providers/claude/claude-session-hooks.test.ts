/* No production exports. Tests protect compact recall directive injection, commentary hint delivery, and the Claude Edit/Write claim gate. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import ClaudeCommentaryNudge, { CLAUDE_COMMENTARY_HINT } from "./ClaudeCommentaryNudge";
import { CLAUDE_COMPACTION_RECALL_CONTEXT } from "./claude-compaction-recall";
import { createClaudeSessionHooks, type ClaudeFileClaimCheck } from "./claude-session-hooks";

const cwd = path.resolve("/repo");

function run(check: ClaudeFileClaimCheck, toolInput: object, tool = "Edit") {
  const denied: string[] = [];
  const checked: string[][] = [];
  const hooks = createClaudeSessionHooks({
    cwd, onDenied: id => denied.push(id), nudge: new ClaudeCommentaryNudge(),
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

test("plain assistant text reaches Claude as hint context after its tool batch and at a prose stop", async () => {
  const nudge = new ClaudeCommentaryNudge();
  const hooks = createClaudeSessionHooks({
    cwd, onDenied: () => undefined, nudge,
    check: async () => ({ allowed: true, pendingProposals: [], uncoveredPaths: [] }),
  });
  const base = { session_id: "session", transcript_path: "", cwd };
  const context = (result: unknown) =>
    (result as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } }).hookSpecificOutput;
  const batch = () => hooks.PostToolBatch[0]!.hooks[0]!(
    { ...base, hook_event_name: "PostToolBatch", tool_calls: [] } as never, undefined, { signal: new AbortController().signal });
  const stop = (text: string) => hooks.Stop[0]!.hooks[0]!(
    { ...base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: text } as never,
    undefined, { signal: new AbortController().signal });

  assert.deepEqual(await batch(), {});
  nudge.observe({
    type: "assistant", parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "t", name: "Read", input: {} }] },
  } as unknown as SDKMessage);
  assert.deepEqual(context(await batch()), { hookEventName: "PostToolBatch", additionalContext: CLAUDE_COMMENTARY_HINT });
  assert.deepEqual(await stop("<wb:end />"), {});
  assert.deepEqual(context(await stop("Done.")), { hookEventName: "Stop", additionalContext: CLAUDE_COMMENTARY_HINT });
});

test("only native compaction injects the recall directive", async () => {
  const hooks = createClaudeSessionHooks({
    cwd, onDenied: () => undefined, nudge: new ClaudeCommentaryNudge(),
    check: async () => ({ allowed: true, pendingProposals: [], uncoveredPaths: [] }),
  });
  const hook = hooks.SessionStart[0]!.hooks[0]!;

  const result = await hook({
    hook_event_name: "SessionStart", source: "compact",
    session_id: "session", transcript_path: "", cwd,
  } as never, undefined, { signal: new AbortController().signal });
  const output = result as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  assert.equal(output.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.equal(output.hookSpecificOutput?.additionalContext, CLAUDE_COMPACTION_RECALL_CONTEXT);

  for (const source of ["startup", "resume", "clear", "fork"] as const) {
    assert.deepEqual(await hook({
      hook_event_name: "SessionStart", source,
      session_id: "session", transcript_path: "", cwd,
    } as never, undefined, { signal: new AbortController().signal }), {});
  }
});

test("a claimed path passes without a decision, resolved against the thread cwd", async () => {
  const { result, denied, checked } = await run(async () => ({ allowed: true, pendingProposals: [], uncoveredPaths: [] }), { file_path: "src/a.ts" });
  assert.equal(decision(result), undefined);
  assert.deepEqual(checked, [[path.resolve(cwd, "src/a.ts")]]);
  assert.deepEqual(denied, []);
});

test("an unclaimed path is denied and reported for transcript presentation", async () => {
  const target = path.resolve(cwd, "b.ts");
  const { result, denied } = await run(async () => ({ allowed: false, pendingProposals: [], uncoveredPaths: [target] }), { file_path: target }, "Write");
  assert.equal(decision(result), "deny");
  assert.deepEqual(denied, ["tool-1"]);
});

test("a pending proposal's file is denied without the unclaimed transcript marker", async () => {
  const target = path.resolve(cwd, "b.ts");
  const { result, denied } = await run(async () => ({
    allowed: false, pendingProposals: [{ paths: [target], proposalId: "p1" }], uncoveredPaths: [],
  }), { file_path: target });
  assert.equal(decision(result), "deny");
  assert.deepEqual(denied, []);
});

test("claim check failures and unreadable paths deny rather than letting the edit through", async context => {
  context.mock.method(console, "warn", () => undefined);
  const failed = await run(async () => { throw new Error("git unavailable"); }, { file_path: "c.ts" });
  assert.equal(decision(failed.result), "deny");
  assert.deepEqual(failed.denied, [], "a broken check is not a claim denial");
  const missing = await run(async () => ({ allowed: true, pendingProposals: [], uncoveredPaths: [] }), { path: "opencode-shape.ts" });
  assert.equal(decision(missing.result), "deny");
  assert.deepEqual(missing.checked, []);
});

test("tools that merely resemble Edit or Write are not judged", async () => {
  const { result, checked } = await run(async () => ({ allowed: false, pendingProposals: [], uncoveredPaths: [] }), { notebook_path: "a.ipynb" }, "NotebookEdit");
  assert.equal(decision(result), undefined);
  assert.deepEqual(checked, []);
});
