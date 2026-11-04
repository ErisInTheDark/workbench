/*
 * No exports. Tests protect passive context admission, source isolation, acknowledgement ownership, and holding undeliverable
 * publishes until the thread's next input boundary.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import WorkbenchAgentContextController, { type WorkbenchAgentContextSource } from "./WorkbenchAgentContextController";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

const target = { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse("thread") };

test("push and collection share admission while acknowledging only delivered contributions", async () => {
  const events: string[] = [];
  const sources: WorkbenchAgentContextSource[] = [{
    id: "events",
    collect: async () => [
      { text: "event", admitted: () => { events.push("ack"); } },
      { text: " ", admitted: () => { assert.fail("empty contribution acknowledged"); } },
    ],
  }, {
    id: "current",
    collect: async (_target, trigger) => [{ text: `current:${trigger}` }],
  }];
  const context = new WorkbenchAgentContextController({
    sources,
    inject: async (_target, text) => { events.push(text); return "admitted"; },
    warn: message => assert.fail(message),
  });
  assert.equal(await context.publish(target, "pushed"), "admitted");
  await context.collect(target, "start", new AbortController().signal);
  assert.deepEqual(events, ["pushed", "event", "ack", "current:start"]);
});

test("collector failures and rejected admission preserve unacknowledged events without blocking later sources", async () => {
  const warnings: string[] = [];
  const delivered: string[] = [];
  let acknowledgements = 0;
  const context = new WorkbenchAgentContextController({
    sources: [
      { id: "broken", collect: async () => { throw new Error("private provider payload"); } },
      { id: "events", collect: async () => [{ text: "reject", admitted: () => { acknowledgements++; } }] },
      { id: "next", collect: async () => [{ text: "okay", admitted: () => { acknowledgements++; } }] },
    ],
    inject: async (_target, text) => {
      if (text === "reject") throw new Error("private context");
      delivered.push(text);
      return "admitted";
    },
    warn: message => warnings.push(message),
  });
  await context.collect(target, "answer", new AbortController().signal);
  assert.deepEqual(delivered, ["okay"]);
  assert.equal(acknowledgements, 1);
  assert.equal(warnings.length, 2);
  assert.equal(warnings.some(message => message.includes("private")), false);
});

test("unsupported delivery does not acknowledge and cancelled collection sends nothing", async () => {
  let collected = 0;
  let delivered = 0;
  const context = new WorkbenchAgentContextController({
    sources: [{
      id: "events",
      collect: async () => {
        collected++;
        return [{ text: "event", admitted: () => assert.fail("unsupported event acknowledged") }];
      },
    }],
    inject: async () => { delivered++; return "unsupported"; },
    warn: message => assert.fail(message),
  });
  await context.collect(target, "steer", new AbortController().signal);
  assert.equal(delivered, 1);
  const cancellation = new AbortController();
  cancellation.abort(new Error("cancelled"));
  await assert.rejects(context.collect(target, "steer", cancellation.signal), /cancelled/u);
  assert.equal(collected, 1);
  assert.equal(delivered, 1);
});

test("collection can use the admission owner's direct transport without recursively calling its provider", async () => {
  const delivered: string[] = [];
  const context = new WorkbenchAgentContextController({
    sources: [{ id: "current", collect: async () => [{ text: "fresh" }] }],
    inject: async () => assert.fail("recursive provider admission"),
    warn: message => assert.fail(message),
  });
  await context.collect(target, "start", new AbortController().signal, async (_target, text) => {
    delivered.push(text);
    return "admitted";
  });
  assert.deepEqual(delivered, ["fresh"]);
});

test("cancellation while a source is collecting prevents its late contribution from being admitted", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  const context = new WorkbenchAgentContextController({
    sources: [{
      id: "events", collect: async () => {
        entered.resolve();
        await release.promise;
        return [{ text: "late", admitted: () => assert.fail("cancelled event acknowledged") }];
      },
    }],
    inject: async () => assert.fail("cancelled context admitted"),
    warn: message => assert.fail(message),
  });
  const collecting = context.collect(target, "start", abort.signal);
  const rejected = assert.rejects(collecting, /retired/u);
  await entered.promise;
  abort.abort(new Error("retired"));
  release.resolve();
  await rejected;
});

test("a publish the provider cannot place yet arrives first at that thread's next input boundary, once", async () => {
  const live = new Set<string>();
  const delivered: string[] = [];
  const context = new WorkbenchAgentContextController({
    sources: [{ id: "current", collect: async () => [{ text: "fresh" }] }],
    inject: async (thread, text) => {
      if (!live.has(thread.threadId)) return "unsupported";
      delivered.push(text);
      return "admitted";
    },
    warn: message => assert.fail(message),
  });
  const other = { ...target, threadId: WorkbenchThreadIdSchema.parse("other") };
  assert.equal(await context.publish(target, "notice"), "unsupported");
  await context.collect(other, "start", new AbortController().signal, async (_target, text) => {
    delivered.push(`other:${text}`);
    return "admitted";
  });
  live.add(target.threadId);
  await context.collect(target, "start", new AbortController().signal);
  await context.collect(target, "steer", new AbortController().signal);
  assert.deepEqual(delivered, ["other:fresh", "notice", "fresh", "fresh"]);
});

test("held notices survive a generation handoff and stay held while still undeliverable", async () => {
  const unsupported = { inject: async () => "unsupported" as const, warn: (message: string) => assert.fail(message) };
  const retiring = new WorkbenchAgentContextController({ sources: [], ...unsupported });
  await retiring.publish(target, "notice");
  const replacement = new WorkbenchAgentContextController({ sources: [], ...unsupported, held: retiring.captureHeld() });
  await replacement.collect(target, "start", new AbortController().signal);
  const delivered: string[] = [];
  await replacement.collect(target, "start", new AbortController().signal, async (_target, text) => {
    delivered.push(text);
    return "admitted";
  });
  assert.deepEqual(delivered, ["notice"]);
});

test("acknowledgement failure does not resend admitted context or block the next contribution", async () => {
  const delivered: string[] = [];
  const warnings: string[] = [];
  const context = new WorkbenchAgentContextController({
    sources: [{
      id: "events", collect: async () => [
        { text: "first", admitted: () => { throw new Error("private storage details"); } },
        { text: "second" },
      ],
    }],
    inject: async (_target, text) => { delivered.push(text); return "admitted"; },
    warn: message => warnings.push(message),
  });
  await context.collect(target, "answer", new AbortController().signal);
  assert.deepEqual(delivered, ["first", "second"]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.includes("private"), false);
});
