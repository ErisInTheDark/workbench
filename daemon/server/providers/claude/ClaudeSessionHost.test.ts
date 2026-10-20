/* No production exports. Tests protect hook routing across bridge generations, host-owned session hooks over unread output, and harness disposal of live Claude processes. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import ClaudeSessionHost, { type ClaudeSessionHandlers } from "./ClaudeSessionHost";
import { CLAUDE_COMMENTARY_SERVER_NAME } from "./claude-commentary-tool";

const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const request = { cwd: "C:/repo", threadId, paths: ["C:/repo/a.ts"] };

function handlers(check: ClaudeSessionHandlers["checkFileClaims"]): ClaudeSessionHandlers {
  return { checkFileClaims: check, recordNativeToolDenial: () => undefined };
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
type HookFunction = (input: object, toolUseId?: string) => Promise<{ hookSpecificOutput?: Record<string, unknown> }>;

test("host-owned session hooks see output before they run, without consuming it, and reach the attached bridge", async () => {
  const stray = { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "plain words" }] } } as unknown as SDKMessage;
  let drained!: () => void;
  const finished = new Promise<void>(resolve => { drained = resolve; });
  let hooks!: Record<string, Array<{ hooks: HookFunction[] }>>;
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
  await hooks.PreToolUse![0]!.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "a.ts" } }, "tool");
  assert.deepEqual(checked, [{ cwd: "C:/repo", threadId, paths: [path.resolve("C:/repo", "a.ts")] }]);
  assert.deepEqual(Object.keys(servers).sort(), [CLAUDE_COMMENTARY_SERVER_NAME, "wb"].sort());
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
