/* Exports: none. Protect event-driven waiting, final drain and silent early-completion recovery. */
import assert from "node:assert/strict";
import test from "node:test";
import { beforeEach } from "node:test";
import CodexSingleFileController, { type SingleFileTransport } from "./CodexSingleFileController";
import type { SingleFileEvent } from "workbench-shared/workbench/provider/provider-single-file";
import type { SingleFileJournalTag } from "./CodexSingleFileDocuments";

beforeEach(context => { if ("mock" in context) context.mock.method(console, "info", () => {}); });

async function harness() {
  let observe!: (message: unknown) => Promise<void>;
  const requests: Parameters<SingleFileTransport["request"]>[0][] = [];
  const responses: unknown[] = [];
  const events: SingleFileEvent[] = [];
  const journal: Array<{ tag: SingleFileJournalTag; text: string }> = [];
  let turn = 0;
  let document = "original";
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
        respond(id, result) { responses.push({ id, result }); },
        async dispose() {},
      };
    },
  });
  await controller.start({
    sessionId: "session", text: document, instructions: "edit",
    settings: { harness: "codex", model: "gpt-5.6-luna" },
    onEvent: event => events.push(event),
  });
  const wait = (revision: number) => observe({ id: `wait-${revision}`, method: "item/tool/call",
    params: { threadId: "thread", turnId: `turn-${turn}`, tool: "wait_for_transcript", arguments: {} } });
  const complete = () => observe({ method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${turn}`, status: "completed" } } });
  return { controller, requests, responses, events, journal, wait, complete, observe,
    setRead: (next: () => Promise<string>) => { read = next; },
    setStartTurn: (next: () => Promise<void>) => { startTurn = next; },
    setAppend: (next: () => Promise<void>) => { append = next; },
    isDocumentDisposed: () => disposed,
    setDocument: (value: string) => { document = value; } };
}

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

test("cancellation interrupts a turn whose admission response arrives late", async () => {
  const h = await harness();
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
