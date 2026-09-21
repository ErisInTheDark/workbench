/*
 * No production exports. Tests protect direct live text recording and one terminal canonical settlement.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { OpenCodeEvent } from "@opencode/client";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptNotification } from "workbench-shared/workbench/provider/provider-observation";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import OpenCodeEventController from "./OpenCodeEventController";
import type OpenCodeTranscriptAdapter from "./OpenCodeTranscriptAdapter";
import { readTranscriptText } from "workbench-shared/workbench/transcript/thread-transcript-stream";

test("reasoning deltas target the visible canonical section before completion", async () => {
  const deltas: Parameters<OpenCodeTranscriptAdapter["appendText"]>[0][] = [];
  const owner = new OpenCodeEventController({
    observe: async () => undefined,
    threads: { ...executionLifecycle, currentTurn: () => ({ threadId, turnId }),
      syncNative: async () => ({ threadId }), latestTurn: async () => turn() },
    transcript: { recordItem: async () => "item" as never, recordTurnState: async () => undefined,
      appendText: input => { deltas.push(input); } },
  });
  await owner.accept(event({ type: "session.reasoning.started", created: 1,
    data: { sessionID: "session", assistantMessageID: "assistant", ordinal: 0 } }));
  await owner.accept(event({ type: "session.reasoning.delta", created: 2,
    data: { sessionID: "session", assistantMessageID: "assistant", ordinal: 0, delta: "partial thought" } }));
  const canonical = { type: "reasoning" as const, id: "item", summary: [""], content: [] as string[] };
  const update = deltas[0]!;
  const sections = update.field === "reasoningSummary" ? canonical.summary : canonical.content;
  if (sections[update.index ?? 0] !== undefined) sections[update.index ?? 0] += update.text;
  assert.equal(readTranscriptText(canonical, "reasoningSummary", 0), "partial thought");
});

test("previews join exact native calls in either order and cannot survive request replacement or interruption", async () => {
  const previews: Parameters<OpenCodeTranscriptAdapter["previewToolPatch"]>[0][] = [];
  const items: Parameters<OpenCodeTranscriptAdapter["recordItem"]>[0][] = [];
  const owner = new OpenCodeEventController({
    observe: async () => undefined,
    threads: { ...executionLifecycle, currentTurn: () => ({ threadId, turnId }),
      syncNative: async () => ({ threadId }), latestTurn: async () => turn() },
    transcript: {
      appendText: () => undefined, recordTurnState: async () => undefined,
      recordItem: async input => { items.push(input); return `canonical-${input.source.reference}` as never; },
      previewToolPatch: input => { previews.push(input); },
    },
  });
  const request = { sessionID: "session", requestID: "request-a" };
  const file = { path: "first.ts", kind: { type: "add" as const }, additions: 2 };
  owner.acceptPatchPreview({ ...request, kind: "request" });
  owner.acceptPatchPreview({ ...request, kind: "preview", callID: "a", tool: "patch", files: [file] });
  assert.equal(previews.length, 0);
  await owner.accept(event({ type: "session.tool.input.started", created: 1, data: { sessionID: "session", id: "a", name: "patch" } }));
  assert.equal(previews.at(-1)?.itemId, "canonical-a");
  assert.equal(previews.at(-1)?.files[0]?.path, "first.ts");
  await owner.accept(event({ type: "session.tool.input.started", created: 2, data: { sessionID: "session", id: "b", name: "write" } }));
  owner.acceptPatchPreview({ ...request, kind: "preview", callID: "b", tool: "write", files: [{ ...file, path: "second.ts" }] });
  assert.equal(previews.at(-1)?.itemId, "canonical-b");
  owner.acceptPatchPreview({ ...request, kind: "request", requestID: "request-b" });
  assert.deepEqual(previews.slice(-2).map(preview => preview.files), [[], []]);
  const count = previews.length;
  owner.acceptPatchPreview({ ...request, kind: "preview", callID: "a", tool: "patch", files: [file] });
  assert.equal(previews.length, count);
  owner.acceptPatchPreview({ ...request, requestID: "request-b", kind: "preview", callID: "b", tool: "write", files: [file] });
  await owner.accept(event({ type: "session.execution.interrupted", created: 3, data: { sessionID: "session" } }));
  assert.deepEqual(previews.at(-1)?.files, []);
  owner.dispose();
});

test("native error metadata marks success events failed while retaining complete metadata and pinned turn", async () => {
  const items: Parameters<OpenCodeTranscriptAdapter["recordItem"]>[0][] = [];
  let current = turnId;
  const owner = new OpenCodeEventController({
    observe: async () => undefined,
    threads: { ...executionLifecycle, currentTurn: () => ({ threadId, turnId: current }),
      syncNative: async () => ({ threadId }), latestTurn: async () => ({ ...turn(), id: current }) },
    transcript: { appendText: () => undefined, recordTurnState: async () => undefined,
      recordItem: async input => { items.push(input); return "canonical" as never; } },
  });
  await owner.accept(event({ type: "session.tool.input.started", created: 1, data: { sessionID: "session", id: "call", name: "execute" } }));
  current = WorkbenchTurnIdSchema.parse("new-turn");
  const metadata = { error: true, toolCalls: [{ tool: "search", status: "error" }] };
  await owner.accept(event({ type: "session.tool.success", created: 3,
    data: { sessionID: "session", id: "call", metadata, content: [{ type: "text", text: "actual failure output" }] } }));
  const final = items.at(-1)!;
  assert.equal(final.turnId, turnId);
  assert.ok(final.item.type === "dynamicToolCall");
  assert.equal(final.item.status, "failed");
  assert.deepEqual(final.item.metadata, metadata);
  assert.equal(final.item.toolCallGroupId, "call");
});

test("write settlement replaces its live preview on the same canonical item for success and failure", async () => {
  for (const outcome of ["session.tool.success", "session.tool.failed"] as const) {
    const items: Parameters<OpenCodeTranscriptAdapter["recordItem"]>[0][] = [];
    const previews: Parameters<OpenCodeTranscriptAdapter["previewToolPatch"]>[0][] = [];
    const owner = new OpenCodeEventController({
      observe: async () => undefined,
      threads: { ...executionLifecycle, currentTurn: () => ({ threadId, turnId }),
        syncNative: async () => ({ threadId }), latestTurn: async () => turn() },
      transcript: { appendText: () => undefined, recordTurnState: async () => undefined,
        recordItem: async input => { items.push(input); return "canonical-write" as never; },
        previewToolPatch: input => { previews.push(input); } },
    });
    const request = { sessionID: "session", requestID: "request" };
    owner.acceptPatchPreview({ ...request, kind: "request" });
    await owner.accept(event({ type: "session.tool.input.started", created: 1,
      data: { sessionID: "session", id: "write", name: "write" } }));
    owner.acceptPatchPreview({ ...request, kind: "preview", callID: "write", tool: "write",
      files: [{ path: "new.ts", kind: { type: "add" }, additions: 5 }] });
    const metadata = { files: [{ file: "new.ts", status: "added", patch: outcome === "session.tool.success" ? "+actual" : "" }] };
    await owner.accept(event({ type: outcome, created: 2,
      data: { sessionID: "session", id: "write", metadata, content: [],
        ...(outcome === "session.tool.failed" ? { executed: true, error: { type: "tool", message: "denied" } } : {}) } }));
    assert.equal(previews[0]?.itemId, "canonical-write");
    const final = items.at(-1)!;
    assert.deepEqual(final.source, items[0]?.source);
    assert.ok(final.item.type === "dynamicToolCall");
    assert.deepEqual(final.item.metadata, metadata);
    assert.equal(final.item.patchPreview, undefined);
    assert.equal(final.item.status, outcome === "session.tool.success" ? "completed" : "failed");
    const count = previews.length;
    owner.acceptPatchPreview({ ...request, kind: "preview", callID: "write", tool: "write",
      files: [{ path: "stale.ts", kind: { type: "add" }, additions: 99 }] });
    assert.equal(previews.length, count);
    owner.dispose();
  }
});

const executionLifecycle = {
  acceptExecutionEvent: () => true,
  completeExecution: async () => undefined,
  executionIntentVersion: () => 0,
  markExecutionSettled: (_sessionID: string) => undefined,
  markExecutionStarted: (_sessionID: string) => undefined,
};

test("invalidates cached model catalogues on provider catalogue events", async () => {
  let invalidations = 0;
  const controller = new OpenCodeEventController({
    invalidateModelCatalogs: () => { invalidations++; },
    observe: async () => undefined,
    threads: {
      ...executionLifecycle,
      currentTurn: () => null,
      latestTurn: async () => null,
      syncNative: async () => { throw new Error("session sync must not run"); },
    },
    transcript: {
      appendText: () => undefined,
      recordItem: async () => "item" as never,
      recordTurnState: async () => undefined,
    },
  });
  await controller.accept({ type: "model.updated" } as never);
  await controller.accept({ type: "provider.updated" } as never);
  assert.equal(invalidations, 2);
});

const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const turnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002");
const durable = { aggregateID: "session", seq: 1, version: 1 as const };

function event(value: object) {
  return { durable, ...value } as OpenCodeEvent;
}

function turn(status: Turn["status"] = "inProgress", id: string = turnId): Turn {
  return {
    completedAt: status === "inProgress" ? null : 2,
    durationMs: null,
    error: null,
    id,
    items: [],
    itemsView: "notLoaded",
    startedAt: 1,
    status,
  };
}

test("successful execution reaches unfinished-task enforcement after lifecycle settlement", async () => {
  const calls: string[] = [];
  const controller = new OpenCodeEventController({
    threads: {
      ...executionLifecycle,
      currentTurn: () => ({ threadId, turnId }),
      syncNative: async () => ({ threadId }),
      latestTurn: async () => turn(),
      completeExecution: async () => { calls.push("enforce"); },
    } as never,
    transcript: { appendText: () => undefined, recordItem: async () => "item" as never,
      recordTurnState: async () => undefined },
    observe: async () => { calls.push("observe"); },
  });
  await controller.accept(event({
    id: "end", created: 3, type: "session.execution.succeeded", durable,
    data: { sessionID: "session" },
  }));
  assert.deepEqual(calls, ["observe", "enforce"]);
});

test("terminal reconciliation never settles a newer user turn", async () => {
  for (const changeDuring of ["sync", "latest"] as const) {
    let current = turnId;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const settled: string[] = [];
    const controller = new OpenCodeEventController({
      threads: {
        ...executionLifecycle,
        currentTurn: () => ({ threadId, turnId: current }),
        syncNative: async () => {
          if (changeDuring === "sync") { entered.resolve(); await release.promise; }
          return { threadId, latestTurnId: turnId };
        },
        latestTurn: async () => {
          entered.resolve();
          await release.promise;
          return { ...turn(), id: current };
        },
        markExecutionSettled: () => { settled.push("settled"); },
        completeExecution: async () => { settled.push("continued"); },
      },
      observe: async () => { settled.push("observed"); },
      transcript: { appendText: () => undefined, recordItem: async () => "item" as never,
        recordTurnState: async () => { settled.push("recorded"); } },
    });
    const completion = controller.accept(event({ type: "session.execution.succeeded",
      id: "end", created: 3, data: { sessionID: "session" } }));
    await entered.promise;
    current = WorkbenchTurnIdSchema.parse("new-turn");
    release.resolve();
    await completion;
    assert.deepEqual(settled, []);
  }
});

test("streams text directly and performs one canonical read at execution settlement", async () => {
  let syncs = 0;
  const started: string[] = [];
  const settled: string[] = [];
  const recorded: { source: object; lifecycle: string; text: string }[] = [];
  const deltas: string[] = [];
  const lifecycle: string[] = [];
  const turnStates: string[] = [];
  const controller = new OpenCodeEventController({
    threads: {
      ...executionLifecycle,
      currentTurn: () => ({ threadId, turnId }),
      markExecutionSettled: sessionID => { settled.push(sessionID); },
      markExecutionStarted: sessionID => { started.push(sessionID); },
      syncNative: async () => {
        syncs++;
        return { threadId };
      },
      latestTurn: async () => turn("completed"),
    },
    transcript: {
      recordTurnState: async input => { turnStates.push(input.state); },
      recordItem: async input => {
        recorded.push({
          source: input.source,
          lifecycle: input.lifecycle,
          text: input.item.type === "agentMessage" ? input.item.text : "",
        });
        return "00000000-0000-4000-8000-000000000003" as never;
      },
      appendText: input => { deltas.push(input.text); },
    },
    observe: async facts => {
      if (facts.activity?.kind === "turnStarted") lifecycle.push("started");
      if (facts.lifecycle?.event.kind === "turnCompleted") lifecycle.push(facts.lifecycle.event.status);
    },
  });

  await controller.accept(event({
    id: "execution-start", created: 1, type: "session.execution.started", durable,
    data: { sessionID: "session" },
  }));
  await controller.accept(event({
    id: "text-start", created: 2, type: "session.text.started", durable,
    data: { sessionID: "session", assistantMessageID: "assistant", ordinal: 0 },
  }));
  await controller.accept(event({
    id: "delta-1", created: 3, type: "session.text.delta",
    data: { sessionID: "session", assistantMessageID: "assistant", ordinal: 0, delta: "hello " },
  }));
  await controller.accept(event({
    id: "delta-2", created: 4, type: "session.text.delta",
    data: { sessionID: "session", assistantMessageID: "assistant", ordinal: 0, delta: "world" },
  }));
  await controller.accept(event({
    id: "text-end", created: 5, type: "session.text.ended", durable,
    data: { sessionID: "session", assistantMessageID: "assistant", ordinal: 0, text: "hello world" },
  }));
  await controller.accept(event({
    id: "execution-end", created: 6, type: "session.execution.succeeded", durable,
    data: { sessionID: "session" },
  }));

  assert.deepEqual(recorded, [
    {
      source: { reference: "assistant", component: { kind: "text", index: 0 } },
      lifecycle: "streaming",
      text: "",
    },
    {
      source: { reference: "assistant", component: { kind: "text", index: 0 } },
      lifecycle: "completed",
      text: "hello world",
    },
  ]);
  assert.deepEqual(deltas, ["hello ", "world"]);
  assert.deepEqual(lifecycle, ["started", "completed"]);
  assert.deepEqual(turnStates, ["inProgress"],
    "Successful settlement must preserve the canonical history timestamp");
  assert.equal(syncs, 1);
  assert.deepEqual(started, ["session"]);
  assert.deepEqual(settled, ["session"]);
});

test("keeps reused tool ids isolated by native session", async () => {
  const recorded: Array<{ content: unknown; source: object; tool: string }> = [];
  const controller = new OpenCodeEventController({
    threads: {
      ...executionLifecycle,
      currentTurn: () => ({ threadId, turnId }),
      syncNative: async () => ({ threadId }),
      latestTurn: async () => null,
    },
    transcript: {
      recordTurnState: async () => undefined,
      recordItem: async input => {
        if (input.item.type === "dynamicToolCall") {
          recorded.push({
            content: input.item.contentItems,
            source: input.source,
            tool: input.item.tool,
          });
        }
        return "00000000-0000-4000-8000-000000000003" as never;
      },
      appendText: () => undefined,
    },
    observe: async () => undefined,
  });

  await controller.accept(event({
    id: "tool-a-start", created: 1, type: "session.tool.input.started", durable,
    data: { sessionID: "session-a", id: "tool-1", name: "read" },
  }));
  await controller.accept(event({
    id: "tool-b-start", created: 2, type: "session.tool.input.started", durable,
    data: { sessionID: "session-b", id: "tool-1", name: "write" },
  }));
  await controller.accept(event({
    id: "tool-a-end", created: 3, type: "session.tool.success", durable,
    data: { sessionID: "session-a", id: "tool-1", output: "", content: [] },
  }));

  assert.deepEqual(recorded.at(-1), {
    content: null,
    source: { reference: "tool-1", component: { kind: "item", index: 0 } },
    tool: "read",
  });

  await controller.accept(event({
    id: "tool-b-end", created: 4, type: "session.tool.failed", durable,
    data: {
      sessionID: "session-b", id: "tool-1", executed: true,
      error: { type: "tool", message: "permission denied" },
    },
  }));
  assert.deepEqual(recorded.at(-1), {
    content: [{ type: "inputText", text: "permission denied" }],
    source: { reference: "tool-1", component: { kind: "item", index: 0 } },
    tool: "write",
  });
});

test("materialises an admitted steer only when OpenCode delivers its inbox item", async () => {
  let syncs = 0;
  const controller = new OpenCodeEventController({
    threads: {
      ...executionLifecycle,
      currentTurn: () => ({ threadId, turnId }),
      syncNative: async () => {
        syncs++;
        return { threadId };
      },
      latestTurn: async () => null,
    },
    transcript: {
      recordTurnState: async () => undefined,
      recordItem: async () => "00000000-0000-4000-8000-000000000003" as never,
      appendText: () => undefined,
    },
    observe: async () => undefined,
  });

  await controller.accept(event({
    id: "tool-end", created: 1, type: "session.tool.success", durable,
    data: { sessionID: "session", id: "tool-1", output: "", content: [] },
  }));
  assert.equal(syncs, 0);

  await controller.accept(event({
    id: "steer-delivered", created: 2, type: "session.inbox.delivered", durable,
    data: { sessionID: "session", inboxID: "inbox-1" },
  }));
  assert.equal(syncs, 1);
});

test("does not complete a WB turn while its next OpenCode steer is pending", async () => {
  const lifecycle: string[] = [];
  const notifications: WorkbenchTranscriptNotification[] = [];
  const controller = new OpenCodeEventController({
    broadcast: notification => { notifications.push(notification); },
    threads: {
      ...executionLifecycle,
      currentTurn: () => ({ threadId, turnId }),
      syncNative: async () => ({ threadId, hasPendingSteers: true }),
      latestTurn: async () => turn(),
    },
    transcript: {
      recordTurnState: async () => undefined,
      recordItem: async () => "00000000-0000-4000-8000-000000000003" as never,
      appendText: () => undefined,
    },
    observe: async facts => {
      if (facts.lifecycle?.event.kind === "turnCompleted") lifecycle.push(facts.lifecycle.event.status);
    },
  });

  await controller.accept(event({
    id: "execution-end", created: 3, type: "session.execution.succeeded", durable,
    data: { sessionID: "session" },
  }));
  assert.deepEqual(lifecycle, []);
  assert.deepEqual(notifications, [], "A pending steer keeps the app's turn active.");
});

test("broadcasts one settled turn and idle status when an execution ends", async () => {
  const notifications: WorkbenchTranscriptNotification[] = [];
  const controller = new OpenCodeEventController({
    broadcast: notification => { notifications.push(notification); },
    observe: async () => undefined,
    threads: {
      ...executionLifecycle,
      currentTurn: () => ({ threadId, turnId }),
      syncNative: async () => ({ threadId, latestTurnId: turnId }),
      latestTurn: async () => turn("completed"),
    },
    transcript: { appendText: () => undefined, recordItem: async () => "item" as never,
      recordTurnState: async () => undefined },
  });

  await controller.accept(event({
    id: "execution-end", created: 3, type: "session.execution.succeeded", durable,
    data: { sessionID: "session" },
  }));

  assert.deepEqual(notifications, [
    { method: "turn/completed", params: { threadId, turn: turn("completed") } },
    { method: "thread/status/changed", params: { threadId, status: { type: "idle" } } },
  ]);
});

test("broadcasts an inbox-delivered turn as the app's active turn", async () => {
  const notifications: WorkbenchTranscriptNotification[] = [];
  const controller = new OpenCodeEventController({
    broadcast: notification => { notifications.push(notification); },
    observe: async () => undefined,
    threads: {
      ...executionLifecycle,
      currentTurn: () => ({ threadId, turnId }),
      syncNative: async () => ({ threadId }),
      latestTurn: async () => turn(),
    },
    transcript: { appendText: () => undefined, recordItem: async () => "item" as never,
      recordTurnState: async () => undefined },
  });

  await controller.accept(event({
    id: "steer-delivered", created: 2, type: "session.inbox.delivered", durable,
    data: { sessionID: "session", inboxID: "inbox-1" },
  }));

  assert.deepEqual(notifications, [
    { method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: [] } } },
    { method: "turn/started", params: { threadId, turn: turn() } },
  ]);
});

test("maps OpenCode cancellation failure to interrupted after a WB stop", async () => {
  const lifecycle: string[] = [];
  const states: string[] = [];
  const notifications: WorkbenchTranscriptNotification[] = [];
  const controller = new OpenCodeEventController({
    broadcast: notification => { notifications.push(notification); },
    threads: {
      ...executionLifecycle,
      currentTurn: () => ({ threadId, turnId }),
      consumeRequestedInterrupt: () => true,
      syncNative: async () => ({ threadId, hasPendingSteers: false }),
      latestTurn: async () => turn(),
    },
    transcript: {
      recordTurnState: async input => { states.push(input.state); },
      recordItem: async () => "00000000-0000-4000-8000-000000000003" as never,
      appendText: () => undefined,
    },
    observe: async facts => {
      if (facts.lifecycle?.event.kind === "turnCompleted") lifecycle.push(facts.lifecycle.event.status);
    },
  });

  await controller.accept(event({
    id: "execution-failed", created: 3, type: "session.execution.failed", durable,
    data: { sessionID: "session", error: { name: "Cancelled", message: "cancelled" } },
  }));
  assert.deepEqual(states, ["interrupted"]);
  assert.deepEqual(lifecycle, ["interrupted"]);
  assert.deepEqual(notifications, [
    { method: "turn/completed", params: { threadId, turn: { ...turn(), status: "interrupted" } } },
    { method: "thread/status/changed", params: { threadId, status: { type: "idle" } } },
  ]);
});
