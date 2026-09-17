/* Exports: none. Protect event-driven waiting, final drain and silent early-completion recovery. */
import assert from "node:assert/strict";
import test from "node:test";
import CodexSingleFileController, { type SingleFileTransport } from "./CodexSingleFileController";
import type { SingleFileEvent } from "workbench-shared/workbench/provider/provider-single-file";

async function harness() {
  let observe!: (message: unknown) => Promise<void>;
  const requests: Parameters<SingleFileTransport["request"]>[0][] = [];
  const responses: unknown[] = [];
  const events: SingleFileEvent[] = [];
  let turn = 0;
  let document = "original";
  let read = async () => document;
  let startTurn = async () => {};
  let steer = async () => {};
  const controller = new CodexSingleFileController({
    createDocument: async () => ({ directory: "/scratch", file: "/scratch/document.txt", read: () => read(), dispose: async () => {} }),
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
          if (request.method === "turn/steer") await steer();
          return {};
        },
        respond(id, result) { responses.push({ id, result }); },
        async dispose() {},
      };
    },
  });
  await controller.start({
    sessionId: "session", text: document, instructions: "edit",
    settings: { harness: "codex", model: "gpt-5.6-luna", reasoningEffort: "none", agentPath: null, agentSource: null, serviceTier: null },
    onEvent: event => events.push(event),
  });
  const wait = (revision: number) => observe({ id: `wait-${revision}`, method: "item/tool/call",
    params: { threadId: "thread", turnId: `turn-${turn}`, tool: "wait_for_transcript", arguments: { revision } } });
  const complete = () => observe({ method: "turn/completed", params: { threadId: "thread", turn: { id: `turn-${turn}`, status: "completed" } } });
  return { controller, requests, responses, events, wait, complete, observe,
    setRead: (next: () => Promise<string>) => { read = next; },
    setStartTurn: (next: () => Promise<void>) => { startTurn = next; },
    setSteer: (next: () => Promise<void>) => { steer = next; },
    setDocument: (value: string) => { document = value; } };
}

test("a packet admitted before idle wait returns immediately; final packet drains", async () => {
  const h = await harness();
  await h.controller.input("session", { revision: 1, transcript: "new", final: false });
  await h.wait(0);
  assert.equal(h.responses.length, 1);
  await h.wait(1);
  assert.equal(h.responses.length, 1);
  await h.controller.input("session", { revision: 2, transcript: "new", final: true });
  assert.equal(h.responses.length, 2);
  const finishing = h.controller.finish("session");
  await h.complete();
  await finishing;
  assert.equal(h.events.at(-1)?.type, "finished");
});

test("an old completion cannot finish a recovery turn carrying final input", async () => {
  const h = await harness();
  let entered!: () => void;
  let reject!: (error: Error) => void;
  const steering = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>((_resolve, fail) => { reject = fail; });
  h.setSteer(async () => { entered(); await gate; });
  const admission = h.controller.input("session", { revision: 1, transcript: "final edit", final: true });
  await steering;
  const oldCompletion = h.complete();
  reject(new Error("turn already completed"));
  await Promise.all([admission, oldCompletion]);
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
  let release!: (text: string) => void;
  const contents = new Promise<string>(resolve => { release = resolve; });
  h.setRead(() => contents);
  await h.observe({ method: "item/completed", params: {
    threadId: "thread", item: { type: "fileChange", status: "completed" },
  } });
  await h.controller.input("session", { revision: 1, transcript: "replace original", final: true });
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
  await h.controller.input("session", { revision: 1, transcript: "continue", final: false });
  assert.equal(h.requests.filter(r => r.method === "turn/start").length, 3);
  assert.deepEqual(h.events, []);
  await h.controller.cancel("session");
});
