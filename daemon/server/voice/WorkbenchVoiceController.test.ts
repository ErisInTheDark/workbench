/* Exports: none. Protect connection ownership, final drain and stale-session fencing. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchVoiceController from "./WorkbenchVoiceController";
import type { VoiceSessionEvent } from "workbench-shared/workbench/voice/voice-session-contract";
import type { VoiceRequest } from "workbench-shared/workbench/voice/voice-contract";
import type { WorkbenchProviderSingleFile } from "workbench-shared/workbench/provider/provider-single-file";

function createHarness(provider: WorkbenchProviderSingleFile, recording?: ConstructorParameters<typeof WorkbenchVoiceController>[0]["recording"]) {
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
    recording,
  });
  return { controller, events, native, start: (id: string, recordAudio = false) => controller.start("connection", { sessionId: id, text: "", recordAudio }, event => events.push(event)) };
}
const provider: WorkbenchProviderSingleFile = {
  async prepare() {}, async start() { return { directory: "/scratch" }; }, async input() {}, async finish() {}, async cancel() {},
};

test("late failure from cancelled startup cannot cancel its successor", async context => {
  context.mock.method(console, "warn", () => {});
  let reject!: (error: Error) => void;
  let entered!: () => void;
  const starting = new Promise<void>(resolve => { entered = resolve; });
  const failed = new Promise<void>((_resolve, fail) => { reject = fail; });
  const h = createHarness({ ...provider, start: async input => {
    if (input.sessionId === "old") { entered(); await failed; }
    return { directory: "/scratch" };
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

test("opt-out never opens audio and opt-in preserves admitted PCM before final retirement", async () => {
  const calls: string[] = [];
  const frames: Buffer[] = [];
  const h = createHarness({ ...provider, finish: async () => { calls.push("provider-finish"); } }, directory => {
    assert.equal(directory, "/scratch");
    calls.push("open");
    return {
      async prepare() {},
      async append(pcm) { frames.push(pcm); },
      async close() { calls.push("close"); },
    };
  });
  await h.start("off");
  await h.controller.audio("connection", { sessionId: "off", sequence: 0, pcm: "AAAA" });
  await h.controller.finish("connection", "off");
  assert.deepEqual(calls, ["provider-finish"]);
  calls.length = 0;
  await h.start("on", true);
  const pcm = Buffer.from([0, 128, 255, 127]);
  await h.controller.audio("connection", { sessionId: "on", sequence: 0, pcm: pcm.toString("base64") });
  await h.controller.finish("connection", "on");
  assert.deepEqual(frames, [pcm]);
  assert.deepEqual(calls, ["open", "close", "provider-finish"]);
});

for (const route of ["cancel", "disconnect", "dispose"] as const) {
  test(`${route} waits for recording closure before retiring its directory`, async () => {
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let retired = false;
    const h = createHarness({ ...provider, cancel: async () => { retired = true; } }, () => ({
      async prepare() {}, async append() {},
      close() { entered.resolve(); return closed.promise; },
    }));
    await h.start("session", true);
    const cancelling = route === "cancel" ? h.controller.cancel("connection", "session")
      : route === "disconnect" ? h.controller.disconnect("connection") : h.controller.dispose();
    await entered.promise;
    assert.equal(retired, false);
    closed.resolve();
    await cancelling;
    assert.equal(retired, true);
    assert.equal(h.events.at(-1)?.type, "cancelled");
  });
}

test("a recording failure is visible and still retires the provider", async context => {
  context.mock.method(console, "warn", () => {});
  const retired = Promise.withResolvers<void>();
  const h = createHarness({ ...provider, cancel: async () => { retired.resolve(); } }, () => ({
    async prepare() {},
    async append() { throw new Error("recording disk failed"); },
    async close() { throw new Error("recording disk failed"); },
  }));
  await h.start("session", true);
  await assert.rejects(h.controller.audio("connection", { sessionId: "session", sequence: 0, pcm: "AAAA" }), /disk failed/);
  await retired.promise;
  assert.ok(h.events.some(event => event.type === "error" && /disk failed/.test(event.message)));
  assert.equal(h.native.some(request => request.type === "audio"), false);
});

test("cancellation while the audio file opens drains the same writer and never starts capture", async () => {
  const opening = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  let retired = false;
  const h = createHarness({ ...provider, cancel: async () => { retired = true; } }, () => ({
    prepare() { opening.resolve(); return opened.promise; }, async append() {},
    close() { return opened.promise; },
  }));
  const starting = h.start("session", true);
  await opening.promise;
  const cancelling = h.controller.cancel("connection", "session");
  assert.equal(retired, false);
  opened.resolve();
  await Promise.all([starting, cancelling]);
  assert.equal(retired, true);
  assert.equal(h.native.some(request => request.type === "start"), false);
});
