/*
 * No production exports. Tests protect native path translation and session binding; Workbench owns the hosted shell.
 */
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import OpenCodeToolsController from "./OpenCodeToolsController";
import {
  WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import type { WorkbenchProviderTools } from "../../provider-execution";

test("native mutation admission checks every resource against the resolved caller", async () => {
  const checked: object[] = [];
  const controller: WorkbenchProviderTools = new OpenCodeToolsController({
    resolveCaller: async () => ({ harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("owner"), cwd: "/repo" }),
    prepareExecution: async () => { throw new Error("must not execute"); },
  });
  const input = { callerThreadId: null, raw: JSON.stringify({
    sessionID: "native", resources: ["src/old.ts", "src/new.ts", "removed.ts"],
  }) };
  const result = JSON.parse(await controller.patchClaims(input, async value => {
    checked.push(value);
    return { allowed: false, uncoveredPaths: ["src/new.ts", "removed.ts"] };
  }, new AbortController().signal));
  assert.equal(result.allowed, false);
  assert.deepEqual(checked, [{
    cwd: "/repo", harness: "opencode", threadId: "owner",
    paths: ["src/old.ts", "src/new.ts", "removed.ts"].map(resource => path.resolve("/repo", resource)),
  }]);
  assert.match(result.reason, /src\/new.ts/);
  assert.match(result.reason, /removed.ts/);
});

test("native admission propagates cancellation and never substitutes caller-supplied ownership", async () => {
  const signal = new AbortController();
  let checked = 0;
  const owner = new OpenCodeToolsController({
    resolveCaller: async () => ({ harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("real-owner"), cwd: "/real" }),
    prepareExecution: async () => { throw new Error("must not execute"); },
  });
  const input = { callerThreadId: "forged", raw: JSON.stringify({ sessionID: "native", resources: ["ignored/generated.ts"] }) };
  assert.deepEqual(JSON.parse(await owner.patchClaims(input, async caller => {
    checked++;
    assert.equal(caller.threadId, "real-owner");
    assert.equal(caller.cwd, "/real");
    return { allowed: true, uncoveredPaths: [] };
  }, signal.signal)), { allowed: true });
  await assert.rejects(owner.patchClaims(input, async () => {
    checked++;
    signal.abort(new Error("disposed"));
    return { allowed: true, uncoveredPaths: [] };
  }, signal.signal), /disposed/);
  await assert.rejects(owner.patchClaims(input, async () => {
    checked++;
    return { allowed: true, uncoveredPaths: [] };
  }, signal.signal), /disposed/);
  assert.equal(checked, 2);
});

test("transcript capture requires valid child context and resolves authoritative session ownership", async () => {
  const sessions: string[] = [];
  let starts = 0;
  const owner = new OpenCodeToolsController({
    resolveCaller: async id => {
      sessions.push(id);
      return { harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("owned"), cwd: "/repo" };
    },
    prepareExecution: async () => { throw new Error("not executing"); },
    transcript: {
      start: async (_input, context, caller) => {
        starts++;
        assert.equal(context.parentID, "parent");
        assert.equal(caller.threadId, "owned");
        return null;
      },
      finish: async () => undefined,
    },
  });
  const signal = new AbortController().signal;
  const input = { tool: "task_get", arguments: {}, metadata: { sessionID: "native" } };
  assert.equal(await owner.transcript.start(input, signal), null);
  await assert.rejects(owner.transcript.start({ ...input, metadata: { ...input.metadata, workbenchTool: { childID: "invalid" } } }, signal));
  assert.equal(starts, 0);
  await owner.transcript.start({ ...input, metadata: { ...input.metadata, workbenchTool: {
    childID: "fcb5b339-e47a-4b57-ae2a-780ca1a8a542", parentID: "parent", assistantMessageID: "assistant",
  } } }, signal);
  assert.deepEqual(sessions, ["native"]);
  assert.equal(starts, 1);
});

test("context rollover starts from the nested MCP child and failed delivery settles it", async () => {
  const lifecycle: string[] = [];
  const turnId = WorkbenchTurnIdSchema.parse("turn");
  const childID = "00000000-0000-4000-8000-000000000031";
  const owner = new OpenCodeToolsController({
    resolveCaller: async () => ({
      harness: "opencode",
      threadId: WorkbenchThreadIdSchema.parse("owned"),
      cwd: "/repo",
    }),
    currentTurn: () => ({ threadId: WorkbenchThreadIdSchema.parse("owned"), turnId }),
    contextRollover: {
      isActiveTool: input => input.reference === `workbench-context-rollover:${childID}`,
      toolFailed: async input => { lifecycle.push(`failed:${input.reference}`); },
      toolStarted: async input => { lifecycle.push(`started:${input.reference}`); },
    },
    prepareExecution: async () => { throw new Error("not executing"); },
    transcript: {
      start: async (input, context, caller) => ({
        threadId: caller.threadId,
        turnId,
        itemId: WorkbenchItemIdSchema.parse("00000000-0000-4000-8000-000000000032"),
        sourceId: context.childID,
        parentId: context.parentID,
        tool: input.tool,
        arguments: input.arguments,
        startedAt: 1,
      }),
      finish: async () => undefined,
    },
  });
  const signal = new AbortController().signal;
  const reference = await owner.transcript.start({
    tool: "thread_compact",
    arguments: {},
    metadata: {
      sessionID: "native",
      workbenchTool: { assistantMessageID: "assistant", childID, parentID: "execute" },
    },
  }, signal);
  assert.ok(reference);
  await owner.transcript.finish(reference, { content: [], isError: true });
  assert.deepEqual(lifecycle, [
    `started:workbench-context-rollover:${childID}`,
    `failed:workbench-context-rollover:${childID}`,
  ]);
});
