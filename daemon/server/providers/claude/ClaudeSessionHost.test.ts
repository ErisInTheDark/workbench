/* No production exports. Tests protect hook routing across bridge generations, unread output observation, and harness disposal of live Claude processes. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import ClaudeSessionHost, { type ClaudeSessionHandlers } from "./ClaudeSessionHost";

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

test("launch observers see every output message in order before any consumer reads it", async () => {
  const messages = [1, 2, 3].map(index => ({ type: "system", uuid: `m${index}` }) as unknown as SDKMessage);
  let drained!: () => void;
  const finished = new Promise<void>(resolve => { drained = resolve; });
  const host = new ClaudeSessionHost({
    viewsRoot: null,
    createQuery: () => ({
      async *[Symbol.asyncIterator]() { yield* messages; drained(); },
      close: () => undefined,
      interrupt: async () => undefined,
    }) as never,
  });
  const observed: SDKMessage[] = [];
  const session = await host.launch({ scope: "scope", captureStderr: false, observe: message => observed.push(message), options: () => ({}) });
  await finished;
  assert.deepEqual(observed, messages);
  const read = await session.read(new AbortController().signal);
  assert.deepEqual(read, { kind: "message", message: messages[0] }, "observation must not consume buffered output");
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
  await host.launch({ scope: "scope", captureStderr: false, observe: () => undefined, options: () => ({}) });
  assert.equal(host.hasPendingWork(), true);
  const waiting = host.call(current => current.checkFileClaims(request));
  await host.dispose();
  assert.equal(closed, true);
  assert.equal(host.get("scope"), undefined);
  assert.equal(host.hasPendingWork(), false);
  await assert.rejects(waiting, /disposed/u);
});
