/*
 * No production exports. Tests protect direct live text recording and one terminal canonical settlement.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { OpenCodeEvent } from "@opencode/client";
import { WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import OpenCodeEventController from "./OpenCodeEventController";

const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const turnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002");
const durable = { aggregateID: "session", seq: 1, version: 1 as const };

function event(value: object) {
  return value as OpenCodeEvent;
}

test("streams text directly and performs one canonical read at execution settlement", async () => {
  let syncs = 0;
  const recorded: { source: object; lifecycle: string; text: string }[] = [];
  const deltas: string[] = [];
  const lifecycle: string[] = [];
  const turnStates: string[] = [];
  const controller = new OpenCodeEventController({
    threads: {
      currentTurn: () => ({ threadId, turnId }),
      syncNative: async () => {
        syncs++;
        return { threadId };
      },
      latestTurn: async () => ({
        id: turnId,
        status: "completed",
        items: [],
        startedAt: 1,
        completedAt: 6,
        error: null,
      }),
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
});

test("keeps reused tool ids isolated by native session", async () => {
  const recorded: Array<{ source: object; tool: string }> = [];
  const controller = new OpenCodeEventController({
    threads: {
      currentTurn: () => ({ threadId, turnId }),
      syncNative: async () => ({ threadId }),
      latestTurn: async () => null,
    },
    transcript: {
      recordTurnState: async () => undefined,
      recordItem: async input => {
        if (input.item.type === "dynamicToolCall") {
          recorded.push({ source: input.source, tool: input.item.tool });
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
    source: { reference: "tool-1", component: { kind: "item", index: 0 } },
    tool: "read",
  });
});

test("materialises an admitted steer only when OpenCode delivers its inbox item", async () => {
  let syncs = 0;
  const controller = new OpenCodeEventController({
    threads: {
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
  const controller = new OpenCodeEventController({
    threads: {
      currentTurn: () => ({ threadId, turnId }),
      syncNative: async () => ({ threadId, hasPendingSteers: true }),
      latestTurn: async () => ({ id: turnId }),
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
});

test("maps OpenCode cancellation failure to interrupted after a WB stop", async () => {
  const lifecycle: string[] = [];
  const states: string[] = [];
  const controller = new OpenCodeEventController({
    threads: {
      currentTurn: () => ({ threadId, turnId }),
      consumeRequestedInterrupt: () => true,
      syncNative: async () => ({ threadId, hasPendingSteers: false }),
      latestTurn: async () => ({ id: turnId }),
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
});
