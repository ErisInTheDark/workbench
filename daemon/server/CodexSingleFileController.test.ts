/* Exports: none. Protect event-driven waiting, final drain and silent early-completion recovery. */
import assert from "node:assert/strict";
import test from "node:test";
import { beforeEach } from "node:test";
import CodexSingleFileController, { type SingleFileTransport } from "./CodexSingleFileController";
import type { SingleFileEvent } from "workbench-shared/workbench/provider/provider-single-file";
import type { SingleFileJournalTag } from "./CodexSingleFileDocuments";
import { decodeVoiceDocument } from "workbench-shared/workbench/voice/voice-document";

beforeEach(context => { if ("mock" in context) context.mock.method(console, "info", () => {}); });

async function harness(voice = false) {
  let observe!: (message: unknown) => Promise<void>;
  const requests: Parameters<SingleFileTransport["request"]>[0][] = [];
  const responses: unknown[] = [];
  const responseReceived = Promise.withResolvers<void>();
  const events: SingleFileEvent[] = [];
  const journal: Array<{ tag: SingleFileJournalTag; text: string }> = [];
  let turn = 0;
  let document = voice ? "original<caret />" : "original";
  let read = async () => document;
  let startTurn = async () => {};
  let append = async () => {};
  let disposed = false;
  const controller = new CodexSingleFileController({
    createDocument: async () => ({ directory: "/scratch", file: "/scratch/document.txt", read: () => read(),
      append: async (tag, text) => { journal.push({ tag, text }); await append(); }, dispose: async () => { disposed = true; } }),
    createTransport(onMessage) {
      observe = onMessage;
      return {
        async request(request) {
          requests.push(request);
          if (request.method === "thread/start") return {
            thread: { id: "thread" }, reasoningEffort: request.params.config?.model_reasoning_effort,
            approvalPolicy: request.params.approvalPolicy,
            activePermissionProfile: { id: request.params.permissions },
          };
          if (request.method === "turn/start") {
            assert.equal(request.params.effort, "none");
            const id = `turn-${++turn}`;
            await startTurn();
            return { turn: { id } };
          }
          return {};
        },
        respond(id, result) { responses.push({ id, result }); responseReceived.resolve(); },
        async dispose() {},
      };
    },
  });
  await controller.start({
    sessionId: "session", text: document, instructions: "edit",
    ...(voice ? { validateDocument: decodeVoiceDocument } : {}),
    settings: { harness: "codex", model: "gpt-5.6-luna" },
    onEvent: event => events.push(event),
  });
  const wait = (revision: number) => observe({ id: `wait-${revision}`, method: "item/tool/call",
    params: { threadId: "thread", turnId: `turn-${turn}`, tool: "wait_for_transcript", arguments: {} } });
  const complete = () => observe({ method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${turn}`, status: "completed" } } });
  const patch = async (text: string) => {
    document = text;
    await observe({ method: "item/completed", params: {
      threadId: "thread", turnId: `turn-${turn}`, item: { type: "fileChange", status: "completed" },
    } });
  };
  return { controller, requests, responses, events, journal, wait, complete, observe, patch, responseReceived: responseReceived.promise,
    setRead: (next: () => Promise<string>) => { read = next; },
    setStartTurn: (next: () => Promise<void>) => { startTurn = next; },
    setAppend: (next: () => Promise<void>) => { append = next; },
    isDocumentDisposed: () => disposed,
    setDocument: (value: string) => { document = value; } };
}

for (const invalid of ["first<caret />\nsecond<caret />", "first\nsecond"]) {
  test(`invalid voice draft ${JSON.stringify(invalid)} requests repair without new speech`, async context => {
    context.mock.method(console, "warn", () => {});
    const h = await harness(true);
    await h.patch(invalid);
    await h.wait(0);
    assert.deepEqual(h.events, []);
    assert.equal(h.responses.length, 1);
    const response = h.responses[0] as { result: { contentItems: Array<{ text: string }> } };
    const feedback = response.result.contentItems[0]!.text;
    assert.ok(feedback.includes(invalid.split("\n")[0]!));
    assert.equal(h.journal.find(event => event.tag === "tool-response")?.text, feedback);
    assert.equal(h.journal.find(event => event.tag === "patch-applied")?.text, invalid);
    await h.patch("first\nsecond<caret />");
    await h.wait(1);
    assert.deepEqual(h.events, [{ type: "document", sessionId: "session", revision: 1, text: "first\nsecond<caret />" }]);
    assert.equal(h.responses.length, 1);
    await h.controller.cancel("session");
  });
}

test("final input and repair feedback share exact evidence; invalid completion recovers once per draft", async context => {
  context.mock.method(console, "warn", () => {});
  const h = await harness(true);
  await h.patch("broken<caret /><caret />");
  await h.controller.input("session", { transcript: "last spoken words", final: true });
  await h.wait(0);
  const response = h.responses[0] as { result: { contentItems: Array<{ text: string }> } };
  assert.equal(h.journal.find(event => event.tag === "vtt")?.text, response.result.contentItems[0]?.text);
  assert.ok(response.result.contentItems[0]!.text.includes("broken<caret /><caret />"));
  await h.complete();
  assert.equal(h.events.some(event => event.type === "finished"), false);
  assert.equal(h.requests.filter(request => request.method === "turn/start").length, 2);
  await h.patch("changed but still missing marker");
  await h.complete();
  assert.equal(h.requests.filter(request => request.method === "turn/start").length, 3);
  const finishing = h.controller.finish("session");
  await h.patch("repaired<caret />");
  await h.complete();
  await finishing;
  assert.deepEqual(h.events.map(event => event.type), ["document", "finished"]);
});

test("unchanged invalid final draft parks recovery without cancelling or reporting success", async context => {
  context.mock.method(console, "warn", () => {});
  const h = await harness(true);
  await h.patch("invalid");
  await h.controller.input("session", { transcript: "done", final: true });
  await h.wait(0);
  await h.complete();
  await h.complete();
  assert.equal(h.requests.filter(request => request.method === "turn/start").length, 2);
  assert.deepEqual(h.events, []);
  await h.controller.cancel("session");
  assert.equal(h.events.at(-1)?.type, "cancelled");
});

test("new speech arriving during repair reads is delivered without replaying the repair draft", async context => {
  context.mock.method(console, "warn", () => {});
  const h = await harness(true);
  const entered = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<string>();
  h.setRead(() => { entered.resolve(); return reading.promise; });
  await h.patch("broken<caret /><caret />");
  const waiting = h.wait(0);
  await entered.promise;
  const input = h.controller.input("session", { transcript: "continuation", final: false });
  reading.resolve("broken<caret /><caret />");
  await Promise.all([waiting, input]);
  const response = h.responses[0] as { result: { contentItems: Array<{ text: string }> } };
  assert.ok(response.result.contentItems[0]!.text.includes("continuation"));
  assert.equal(h.journal.find(event => event.tag === "vtt")?.text, response.result.contentItems[0]?.text);
  assert.deepEqual(h.events, []);
  await h.controller.cancel("session");
});

test("invalid patch wakes an already pending transcript wait without another packet", async context => {
  context.mock.method(console, "warn", () => {});
  const h = await harness(true);
  await h.wait(0);
  assert.equal(h.responses.length, 0);
  await h.patch("two<caret /> markers<caret />");
  await h.responseReceived;
  assert.deepEqual(h.events, []);
  const response = h.responses[0] as { result: { contentItems: Array<{ text: string }> } };
  assert.ok(response.result.contentItems[0]!.text.includes("two<caret /> markers<caret />"));
  await h.controller.cancel("session");
});

test("cancellation during a repair read cannot admit feedback or publish an invalid draft", async () => {
  const h = await harness(true);
  const entered = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<string>();
  h.setRead(() => { entered.resolve(); return reading.promise; });
  await h.patch("broken");
  await entered.promise;
  const waiting = h.wait(0);
  const cancelling = h.controller.cancel("session");
  reading.resolve("broken");
  await Promise.all([waiting, cancelling]);
  assert.deepEqual(h.events.map(event => event.type), ["cancelled"]);
  assert.equal(h.journal.some(event => event.tag === "vtt"), false);
  const responses = h.responses as Array<{ result: { success: boolean } }>;
  assert.ok(responses.every(response => !response.result.success));
});

test("a packet admitted before idle wait returns immediately; final packet drains", async () => {
  const h = await harness();
  await h.controller.input("session", { transcript: "new", final: false });
  await h.wait(0);
  assert.equal(h.responses.length, 1);
  await h.wait(1);
  assert.equal(h.responses.length, 1);
  assert.match(JSON.stringify(h.responses[0]), /new/);
  await h.controller.input("session", { transcript: "new", final: true });
  assert.equal(h.responses.length, 2);
  const finishing = h.controller.finish("session");
  await h.complete();
  await finishing;
  assert.equal(h.events.at(-1)?.type, "finished");
});

test("an old completion cannot finish a recovery turn carrying final input", async () => {
  const h = await harness();
  await h.controller.input("session", { transcript: "final edit", final: true });
  await h.complete();
  assert.equal(h.events.some(event => event.type === "finished"), false);
  const finishing = h.controller.finish("session");
  await h.complete();
  await finishing;
  assert.equal(h.events.at(-1)?.type, "finished");
});

test("cancellation interrupts a repair turn whose admission response arrives late", async context => {
  context.mock.method(console, "warn", () => {});
  const h = await harness(true);
  await h.patch("invalid");
  let entered!: () => void;
  let release!: () => void;
  const starting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.setStartTurn(async () => { entered(); await gate; });
  const recovery = h.complete();
  await starting;
  const cancelling = h.controller.cancel("session");
  release();
  await Promise.all([recovery, cancelling]);
  const interrupts = h.requests.filter(request => request.method === "turn/interrupt");
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0]?.params.turnId, "turn-2");
});

test("final completion waits for the actual edited file before publishing finished", async () => {
  const h = await harness();
  await h.controller.input("session", { transcript: "replace original", final: true });
  await h.wait(0);
  let release!: (text: string) => void;
  const contents = new Promise<string>(resolve => { release = resolve; });
  h.setRead(() => contents);
  await h.observe({ method: "item/completed", params: {
    threadId: "thread", item: { type: "fileChange", status: "completed" },
  } });
  const finishing = h.controller.finish("session");
  const completion = h.complete();
  assert.deepEqual(h.events, []);
  release("replacement");
  await completion;
  await finishing;
  assert.deepEqual(h.events.map(event => event.type), ["document", "finished"]);
  assert.equal(h.events[0]?.type === "document" && h.events[0].text, "replacement");
});

test("cancellation releases idle waits and late callbacks cannot revive the session", async () => {
  const h = await harness();
  await h.wait(0);
  await h.controller.cancel("session");
  assert.equal(h.responses.length, 1);
  const count = h.requests.length;
  await h.complete();
  h.setDocument("late edit");
  await h.observe({ method: "item/completed", params: {
    threadId: "thread", item: { type: "fileChange", status: "completed" },
  } });
  assert.equal(h.requests.length, count);
  assert.deepEqual(h.events.map(event => event.type), ["cancelled"]);
});

test("first premature completion restarts silently, repeated no-progress completion parks", async () => {
  const h = await harness();
  await h.complete();
  assert.equal(h.requests.filter(r => r.method === "turn/start").length, 2);
  await h.complete();
  assert.equal(h.requests.filter(r => r.method === "turn/start").length, 2);
  await h.controller.input("session", { transcript: "continue", final: false });
  assert.equal(h.requests.filter(r => r.method === "turn/start").length, 3);
  assert.deepEqual(h.events, []);
  await h.controller.cancel("session");
});

test("journal records the exact model payloads and coalesces only undelivered context", async () => {
  const h = await harness();
  const thread = h.requests.find(request => request.method === "thread/start");
  if (thread?.method !== "thread/start") throw new Error("No native thread");
  // An empty environment list removes native file tools, even with write permission.
  assert.notDeepEqual(thread.params.environments, []);
  assert.deepEqual(thread.params.config?.permissions, {
    "voice-session": { filesystem: { "/scratch/document.txt": "write" }, network: { enabled: false } },
  });
  const start = h.requests.find(request => request.method === "turn/start");
  assert.equal(start?.method, "turn/start");
  if (start?.method !== "turn/start") throw new Error("No initial turn");
  assert.equal(h.journal.find(event => event.tag === "agent-input")?.text,
    start.params.input[0]?.type === "text" ? start.params.input[0].text : null);
  await h.controller.input("session", { transcript: "first guess", final: false });
  await h.controller.input("session", { transcript: "[add/at] dirt", final: false });
  assert.equal(h.journal.some(event => event.tag === "vtt"), false);
  await h.wait(0);
  const response = h.responses[0] as { result: { contentItems: Array<{ text: string }> } };
  assert.equal(h.journal.find(event => event.tag === "vtt")?.text, response.result.contentItems[0]?.text);
  assert.match(response.result.contentItems[0]!.text, /\[add\/at\] dirt/);
  h.setDocument("changed");
  await h.observe({ method: "item/completed", params: {
    threadId: "thread", item: { type: "fileChange", status: "completed" },
  } });
  await h.controller.cancel("session");
  assert.ok(h.journal.findIndex(event => event.tag === "vtt") < h.journal.findIndex(event => event.tag === "patch-applied"));
});

test("unexpected agent speech and partial reasoning survive cancellation in the journal", async () => {
  const h = await harness();
  const messages = [
    { method: "item/agentMessage/delta", params: { threadId: "thread", itemId: "message", delta: "I will explain instead" } },
    { method: "item/reasoning/textDelta", params: { threadId: "thread", itemId: "reasoning", delta: "partial thought" } },
    { method: "item/completed", params: { threadId: "thread", item: { type: "agentMessage", text: "Wrong behaviour", id: "message" } } },
  ];
  for (const message of messages) await h.observe(message);
  await h.controller.cancel("session");
  assert.deepEqual(h.journal.filter(event => event.tag === "agent-output").map(event => JSON.parse(event.text)), messages);
});

test("journal omits routine native events but retains exact speech and resulting documents", async () => {
  const h = await harness();
  const itemEvent = (method: string, item: object) => ({ method, params: { threadId: "thread", turnId: "turn-1", item } });
  const echo = { type: "userMessage", id: "input", clientId: null, content: [{ type: "text", text: "original", text_elements: [] }] };
  const waiting = { type: "dynamicToolCall", id: "wait-0", namespace: null, tool: "wait_for_transcript", arguments: {},
    status: "inProgress", contentItems: null, success: null, durationMs: null };
  const emptyMessage = { type: "agentMessage", id: "empty", text: "", phase: "final_answer",
    memoryCitation: null, delivery: null, questions: null };
  for (const item of [echo, emptyMessage, { type: "reasoning", id: "empty-thought", summary: [], content: [] }]) {
    await h.observe(itemEvent("item/started", item));
    await h.observe(itemEvent("item/completed", item));
  }
  await h.observe(itemEvent("item/started", waiting));
  await h.wait(0);
  await h.controller.input("session", { transcript: "keep [setup/startup]", final: false });
  const response = h.responses[0] as { result: { contentItems: Array<{ type: string; text: string }> } };
  await h.observe(itemEvent("item/completed", { ...waiting, status: "completed", success: true,
    durationMs: 2, contentItems: response.result.contentItems }));
  const patch = { type: "fileChange", id: "patch", status: "inProgress",
    changes: [{ path: "/scratch/document.txt", kind: { type: "update", move_path: null }, diff: "actual patch" }] };
  await h.observe(itemEvent("item/started", patch));
  h.setDocument("result");
  await h.observe(itemEvent("item/completed", { ...patch, status: "completed" }));
  await h.controller.input("session", { transcript: "keep setup", final: true });
  await h.wait(1);
  const finishing = h.controller.finish("session");
  await h.complete();
  await finishing;
  assert.deepEqual(h.journal.filter(event => event.tag === "agent-output"), []);
  assert.equal(h.journal.find(event => event.tag === "vtt")?.text, response.result.contentItems[0]?.text);
  assert.equal(h.journal.find(event => event.tag === "patch-applied")?.text, "result");
  assert.equal(h.journal.at(-1)?.tag, "completed");
});

test("journal retains unexpected patches, failed waits, attached content and unfamiliar evidence", async () => {
  const h = await harness();
  const items = [
    { type: "fileChange", id: "patch", status: "inProgress", changes: [{ path: "/scratch/document.txt", diff: "attempt" }] },
    { type: "dynamicToolCall", id: "failed", namespace: null, tool: "wait_for_transcript", arguments: {},
      status: "failed", success: false, contentItems: [{ type: "inputText", text: "rejected" }], durationMs: 1 },
    { type: "dynamicToolCall", id: "other", tool: "unexpected_tool", arguments: {}, status: "completed", success: true },
    { type: "dynamicToolCall", id: "invalid", tool: "wait_for_transcript", arguments: { unexpected: true }, status: "completed", success: true },
    { type: "agentMessage", id: "question", text: "", questions: [{ question: "unexpected interaction" }] },
    { type: "agentMessage", id: "citation", text: "", memoryCitation: { entries: ["evidence"] } },
    { type: "agentMessage", id: "future", text: "", newEvidence: "do not hide" },
    { type: "reasoning", id: "thought", summary: ["meaningful"], content: [] },
    { type: "futureItem", id: "future", content: "keep" },
    { type: "fileChange", id: "foreign", status: "completed",
      changes: [{ path: "/other.txt", kind: { type: "update", move_path: null }, diff: "unexpected file" }] },
    { type: "fileChange", id: "declined", status: "declined",
      changes: [{ path: "/scratch/document.txt", kind: { type: "update", move_path: null }, diff: "declined" }] },
  ];
  const messages = items.map(item => ({ method: item.type === "fileChange" && item.status === "inProgress" ? "item/started" : "item/completed",
    params: { threadId: "thread", turnId: "turn-1", item } }));
  messages.push({ method: "item/completed", params: { threadId: "thread", turnId: "turn-1",
    item: { type: "fileChange", id: "patch", status: "failed", changes: [{ path: "/scratch/document.txt", diff: "attempt" }] } } });
  for (const message of messages) await h.observe(message);
  await h.controller.cancel("session");
  assert.deepEqual(h.journal.filter(event => event.tag === "agent-output").map(event => JSON.parse(event.text)), messages);
});

test("final speech includes the current valid draft for whole-document review", async () => {
  const h = await harness(true);
  await h.patch("earlier **intentional** text\nlatest words<caret />");
  await h.controller.input("session", { transcript: "all accumulated speech", final: true });
  await h.wait(0);
  const response = h.responses[0] as { result: { contentItems: Array<{ text: string }> } };
  const text = response.result.contentItems[0]!.text;
  assert.ok(text.includes("earlier **intentional** text"));
  assert.ok(text.includes("latest words<caret />"));
  assert.ok(text.includes("all accumulated speech"));
  assert.equal(h.journal.find(event => event.tag === "vtt")?.text, text);
  const finishing = h.controller.finish("session");
  await h.complete();
  await finishing;
});

test("premature completion remains journal evidence", async () => {
  const h = await harness();
  await h.complete();
  assert.ok(h.journal.some(event => event.tag === "agent-output" && JSON.parse(event.text).method === "turn/completed"));
  await h.controller.cancel("session");
});

test("journal retains rejected requests and provider errors without suppressing responses", async () => {
  const h = await harness();
  const rejected = { id: "invalid-wait", method: "item/tool/call",
    params: { threadId: "thread", turnId: "turn-1", tool: "wait_for_transcript", arguments: { unexpected: true } } };
  const error = { method: "error", params: { threadId: "thread", error: { message: "provider failure" } } };
  await h.observe(rejected);
  await h.observe(error);
  await h.controller.cancel("session");
  assert.deepEqual(h.journal.filter(event => event.tag === "agent-output").map(event => JSON.parse(event.text)), [rejected, error]);
  const response = h.responses[0] as { result: { success: boolean; contentItems: Array<{ text: string }> } };
  assert.equal(response.result.success, false);
  assert.equal(h.journal.find(event => event.tag === "tool-response")?.text, response.result.contentItems[0]?.text);
});

test("a wait arriving before turn admission is retained rather than rejected", async () => {
  const h = await harness();
  const entered = Promise.withResolvers<void>();
  const admission = Promise.withResolvers<void>();
  h.setStartTurn(async () => { entered.resolve(); await admission.promise; });
  const recovery = h.complete();
  await entered.promise;
  const waiting = h.wait(0);
  admission.resolve();
  await Promise.all([recovery, waiting]);
  assert.equal(h.responses.length, 0);
  await h.controller.input("session", { transcript: "early wait survived", final: false });
  assert.equal(h.responses.length, 1);
  assert.match(JSON.stringify(h.responses[0]), /early wait survived/);
  await h.controller.cancel("session");
});

test("journal failure during cancellation still releases the native thread and document", async () => {
  const h = await harness();
  h.setAppend(async () => { throw new Error("journal unavailable"); });
  await assert.rejects(h.controller.cancel("session"), /journal unavailable/);
  assert.ok(h.requests.some(request => request.method === "thread/unsubscribe"));
  assert.equal(h.isDocumentDisposed(), true);
});
