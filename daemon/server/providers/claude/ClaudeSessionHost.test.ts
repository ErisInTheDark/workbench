/* No production exports. Tests protect hook routing across bridge generations, host-owned session hooks over unread output, tool batch declaration before calls run, and harness disposal of live Claude processes. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchAgentMcpRequestRegistry } from "../../agent/workbench-agent-mcp-request-registry";
import ClaudeSessionHost, { type ClaudeSessionHandlers } from "./ClaudeSessionHost";
import { CLAUDE_COMMENTARY_SERVER_NAME } from "./claude-commentary-tool";

const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const request = { cwd: "C:/repo", threadId, paths: ["C:/repo/a.ts"] };

function handlers(
  check: ClaudeSessionHandlers["checkFileClaims"], toolBatch = new WorkbenchAgentMcpRequestRegistry(),
): ClaudeSessionHandlers {
  return { checkFileClaims: check, recordNativeToolDenial: () => undefined, toolBatch };
}

test("detach waits for hook calls in flight and later hooks reach the next bridge generation", async () => {
  const host = new ClaudeSessionHost({ viewsRoot: null });
  let finishFirst!: () => void;
  const detach = host.attach(handlers(() => new Promise(resolve => {
    finishFirst = () => resolve({ allowed: true, uncoveredPaths: [] });
  })));
  const first = host.call(current => current.checkFileClaims(request));
  let detached = false;
  const detaching = detach().then(() => { detached = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(detached, false, "the retiring bridge must finish its hook call before detach completes");
  const second = host.call(current => current.checkFileClaims(request));
  finishFirst();
  await detaching;
  assert.deepEqual(await first, { allowed: true, uncoveredPaths: [] });
  host.attach(handlers(async () => ({ allowed: false, uncoveredPaths: ["C:/repo/a.ts"] })));
  assert.deepEqual(await second, { allowed: false, uncoveredPaths: ["C:/repo/a.ts"] });
});

const binding = { cwd: "C:/repo", threadId, turnId: WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002") };
type HookFunction = (
  input: object, toolUseId?: string, options?: { signal: AbortSignal },
) => Promise<{ hookSpecificOutput?: Record<string, unknown> }>;
type Hooks = Record<string, Array<{ matcher?: string; hooks: HookFunction[] }>>;
const editHook = (hooks: Hooks) => hooks.PreToolUse!.find(entry => entry.matcher === "Edit|Write")!.hooks[0]!;

test("host-owned session hooks see output before they run, without consuming it, and reach the attached bridge", async () => {
  const stray = { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "plain words" }] } } as unknown as SDKMessage;
  let drained!: () => void;
  const finished = new Promise<void>(resolve => { drained = resolve; });
  let hooks!: Hooks;
  let servers!: Record<string, unknown>;
  const host = new ClaudeSessionHost({
    viewsRoot: null,
    createQuery: (({ options }: { options: { hooks: typeof hooks; mcpServers: typeof servers } }) => {
      hooks = options.hooks;
      servers = options.mcpServers;
      return {
        async *[Symbol.asyncIterator]() { yield stray; drained(); },
        close: () => undefined,
        interrupt: async () => undefined,
      };
    }) as never,
  });
  const checked: unknown[] = [];
  host.attach(handlers(async request => { checked.push(request); return { allowed: true, uncoveredPaths: [] }; }));
  const session = await host.launch({ scope: "scope", captureStderr: false, binding, options: () => ({ mcpServers: { wb: { type: "http", url: "http://wb" } } }) });
  await finished;
  const hint = await hooks.PostToolBatch![0]!.hooks[0]!({ hook_event_name: "PostToolBatch" });
  assert.equal(typeof hint.hookSpecificOutput?.additionalContext, "string", "the stray text was observed before the hook ran");
  assert.deepEqual(await session.read(new AbortController().signal), { kind: "message", message: stray }, "observation must not consume buffered output");
  await editHook(hooks)(
    { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "a.ts" } }, "tool", { signal: new AbortController().signal });
  assert.deepEqual(checked, [{ cwd: "C:/repo", threadId, paths: [path.resolve("C:/repo", "a.ts")] }]);
  assert.deepEqual(Object.keys(servers).sort(), [CLAUDE_COMMENTARY_SERVER_NAME, "wb"].sort());
  await host.dispose();
});

test("a message's calls become its tool batch and their streamed results settle it, so an edit after a failure is skipped", async () => {
  const issued = { type: "assistant", parent_tool_use_id: null, message: { id: "msg", content: [
    { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "a.ts" } },
    { type: "tool_use", id: "edit-2", name: "Edit", input: { file_path: "a.ts" } },
  ] } } as unknown as SDKMessage;
  // A rejected input fails before any hook runs; only its result block reports it.
  const rejected = { type: "user", parent_tool_use_id: null, message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "edit-1", is_error: true, content: "String to replace not found in file." },
  ] } } as unknown as SDKMessage;
  let drained!: () => void;
  const finished = new Promise<void>(resolve => { drained = resolve; });
  let hooks!: Hooks;
  const host = new ClaudeSessionHost({
    viewsRoot: null,
    createQuery: (({ options }: { options: { hooks: typeof hooks } }) => {
      hooks = options.hooks;
      return {
        async *[Symbol.asyncIterator]() { yield issued; yield rejected; drained(); },
        close: () => undefined,
        interrupt: async () => undefined,
      };
    }) as never,
  });
  const registry = new WorkbenchAgentMcpRequestRegistry();
  const checked: unknown[] = [];
  host.attach(handlers(async request => { checked.push(request); return { allowed: true, uncoveredPaths: [] }; }, registry));
  await host.launch({ scope: "scope", captureStderr: false, binding, options: () => ({}) });
  await finished;
  const signal = new AbortController().signal;
  const denied = await editHook(hooks)(
    { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "a.ts" } }, "edit-2", { signal });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(String(denied.hookSpecificOutput?.permissionDecisionReason), /^Skipped: an earlier call in this batch failed/u);
  assert.deepEqual(checked, [], "a skipped edit never reaches the claim check");
  await hooks.PostToolBatch![0]!.hooks[0]!({ hook_event_name: "PostToolBatch" }, undefined, { signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await registry.awaitBatchTurn("edit-2", signal, "Edit", 0), "ready", "the finished batch holds nothing");
  await host.dispose();
});

test("harness disposal closes live processes and fails hooks still waiting for a bridge", async () => {
  let closed = false;
  const host = new ClaudeSessionHost({
    viewsRoot: null,
    createQuery: () => ({
      async *[Symbol.asyncIterator]() {
        while (!closed) await new Promise(resolve => setImmediate(resolve));
      },
      close: () => { closed = true; },
      interrupt: async () => undefined,
    }) as never,
  });
  await host.launch({ scope: "scope", captureStderr: false, binding, options: () => ({}) });
  assert.equal(host.hasPendingWork(), true);
  const waiting = host.call(current => current.checkFileClaims(request));
  await host.dispose();
  assert.equal(closed, true);
  assert.equal(host.get("scope"), undefined);
  assert.equal(host.hasPendingWork(), false);
  await assert.rejects(waiting, /disposed/u);
});
