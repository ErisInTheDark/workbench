/* Exports: none. Protect connection ownership, final drain and stale-session fencing. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchVoiceController from "./WorkbenchVoiceController";
import type { VoiceSessionEvent } from "workbench-shared/workbench/voice/voice-session-contract";
import type { VoiceRequest } from "workbench-shared/workbench/voice/voice-contract";
import type { WorkbenchProviderSingleFile } from "workbench-shared/workbench/provider/provider-single-file";

function createHarness(provider: WorkbenchProviderSingleFile) {
  const events: VoiceSessionEvent[] = [];
  const native: VoiceRequest[] = [];
  const controller = new WorkbenchVoiceController({
    recognizer: {
      async prepare() {}, async dispose() {},
      async send(request) {
        native.push(request);
        if (request.type === "finish") controller.native({ type: "finished", sessionId: request.sessionId });
      },
    },
    async resolveSettings() { return { harness: "codex", model: "luna" }; },
    provider: () => provider,
    instructions: async () => "voice",
  });
  return { controller, events, native, start: (id: string) => controller.start("connection", { sessionId: id, text: "" }, event => events.push(event)) };
}
const provider: WorkbenchProviderSingleFile = {
  async prepare() {}, async start() {}, async input() {}, async finish() {}, async cancel() {},
};

test("late failure from cancelled startup cannot cancel its successor", async context => {
  context.mock.method(console, "warn", () => {});
  let reject!: (error: Error) => void;
  let entered!: () => void;
  const starting = new Promise<void>(resolve => { entered = resolve; });
  const failed = new Promise<void>((_resolve, fail) => { reject = fail; });
  const h = createHarness({ ...provider, start: async input => {
    if (input.sessionId === "old") { entered(); await failed; }
  } });
  const old = h.start("old");
  const rejected = assert.rejects(old, /old startup/);
  await starting;
  await h.controller.cancel("connection", "old");
  await h.start("new");
  reject(new Error("old startup failed"));
  await rejected;
  assert.equal(h.events.some(event => event.sessionId === "new" && (event.type === "error" || event.type === "cancelled")), false);
  await h.controller.cancel("connection", "new");
});

test("foreign connections cannot inject audio and finish waits for transformer drain", async () => {
  let release!: () => void;
  let entered!: () => void;
  const draining = new Promise<void>(resolve => { entered = resolve; });
  const drain = new Promise<void>(resolve => { release = resolve; });
  const h = createHarness({ ...provider, finish: async () => { entered(); await drain; } });
  await h.start("session");
  await assert.rejects(h.controller.audio("foreign", { sessionId: "session", sequence: 0, pcm: "AAAA" }), /another connection/);
  const finish = h.controller.finish("connection", "session");
  await draining;
  assert.equal(h.events.some(event => event.type === "finished"), false);
  release();
  await finish;
  assert.equal(h.events.at(-1)?.type, "finished");
});

test("handoff cancellation releases final drain without reporting success", async () => {
  let release!: () => void;
  let entered!: () => void;
  const draining = new Promise<void>(resolve => { entered = resolve; });
  const drain = new Promise<void>(resolve => { release = resolve; });
  const h = createHarness({
    ...provider,
    finish: async () => { entered(); await drain; },
    cancel: async () => { release(); },
  });
  await h.start("session");
  const finish = h.controller.finish("connection", "session");
  await draining;
  await h.controller.clear();
  await finish;
  assert.equal(h.events.some(event => event.type === "finished"), false);
  assert.equal(h.events.at(-1)?.type, "cancelled");
});
