/* Exports: none. Protect capture availability and cleanup around asynchronous browser permission. */
import assert from "node:assert/strict";
import test from "node:test";
import VoiceCaptureController from "./VoiceCaptureController";

for (const scenario of [
  { name: "remote HTTP", protocol: "http:", secure: false, media: true, supported: false },
  { name: "HTTP localhost", protocol: "http:", secure: true, media: true, supported: false },
  { name: "insecure HTTPS context", protocol: "https:", secure: false, media: true, supported: false },
  { name: "HTTPS without microphone API", protocol: "https:", secure: true, media: false, supported: false },
  { name: "supported HTTPS", protocol: "https:", secure: true, media: true, supported: true },
]) {
  test(`capture admission in ${scenario.name} precedes audio allocation`, async context => {
    let contexts = 0;
    let requests = 0;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const globals = {
      location: { protocol: scenario.protocol },
      isSecureContext: scenario.secure,
      navigator: { mediaDevices: scenario.media ? {
        async getUserMedia() { requests++; enter(); return { getTracks: () => [] }; },
      } : undefined },
    };
    for (const [name, value] of Object.entries(globals)) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, value });
      context.after(() => {
        if (previous) Object.defineProperty(globalThis, name, previous);
        else Reflect.deleteProperty(globalThis, name);
      });
    }
    const capture = new VoiceCaptureController({
      workletUrl: "/voice.js", onFrame() {}, onError(error) { throw error; },
      createContext: () => {
        contexts++;
        return { resume: async () => {}, state: "running", close: async () => {} } as unknown as AudioContext;
      },
    });
    const starting = capture.start().then(value => value, error => error as Error);
    try {
      if (scenario.supported) {
        await entered;
        await capture.cancel();
        assert.equal(await starting, false);
        assert.equal(contexts, 1);
        assert.equal(requests, 1);
      } else {
        assert.equal(contexts, 0, "Unavailable capture must not allocate an audio context");
        assert.ok(await starting instanceof Error);
        assert.equal(requests, 0);
      }
    } finally { await capture.cancel(); await starting; }
  });
}

test("release before audio resume does not request microphone permission afterward", async () => {
  let resume!: () => void;
  let requests = 0;
  let closes = 0;
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  const capture = new VoiceCaptureController({
    workletUrl: "/voice.js", onFrame() {}, onError(error) { throw error; },
    createContext: () => ({
      resume: () => resumed, state: "running", close: async () => { closes++; },
    }) as unknown as AudioContext,
    getUserMedia: async () => { requests++; return { getTracks: () => [] } as unknown as MediaStream; },
  });
  const starting = capture.start();
  await capture.cancel();
  resume();
  assert.equal(await starting, false);
  assert.equal(requests, 0);
  assert.equal(closes, 1);
});

test("permission granted after release stops every late microphone track", async () => {
  let resolve!: (stream: MediaStream) => void;
  let entered!: () => void;
  let stopped = 0;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const permission = new Promise<MediaStream>(next => { resolve = next; });
  const capture = new VoiceCaptureController({
    workletUrl: "/voice.js", onFrame() {}, onError(error) { throw error; },
    createContext: () => ({ resume: async () => {}, state: "running", close: async () => {} }) as unknown as AudioContext,
    getUserMedia: () => { entered(); return permission; },
  });
  const starting = capture.start();
  await requested;
  await capture.finish();
  resolve({ getTracks: () => [{ stop() { stopped++; } }] } as unknown as MediaStream);
  assert.equal(await starting, false);
  assert.equal(stopped, 1);
});

function recordingHarness(soundFailure?: "load" | "play") {
  const events: string[] = [];
  let acknowledge!: () => void;
  const sources: { onended: (() => void) | null; buffer: AudioBuffer | null }[] = [];
  const on = {} as AudioBuffer;
  const off = {} as AudioBuffer;
  const context = {
    state: "running", destination: {}, currentTime: 0,
    resume: async () => {}, close: async () => { events.push("closed"); },
    addEventListener() {}, removeEventListener() {},
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createBufferSource() {
      const source = {
        buffer: null as AudioBuffer | null, onended: null as (() => void) | null,
        connect() {}, disconnect() {}, stop() { source.onended?.(); },
        start() {
          if (soundFailure === "play") throw new Error("Audio output unavailable");
          events.push(source.buffer === on ? "on" : "off");
        },
      };
      sources.push(source);
      return source;
    },
  } as unknown as AudioContext;
  const node = {
    connect() {}, disconnect() {}, onprocessorerror: null,
    port: {
      onmessage: null as ((event: { data: { type: string } }) => void) | null,
      close() {},
      postMessage() { events.push("flush"); acknowledge = () => node.port.onmessage?.({ data: { type: "flushed" } }); },
    },
  };
  const capture = new VoiceCaptureController({
    workletUrl: "/voice.js", onFrame() {}, onError(error) { throw error; },
    createContext: () => context,
    createNode: () => node as unknown as AudioWorkletNode,
    getUserMedia: async () => ({ getTracks: () => [{ stop() { events.push("stopped"); }, addEventListener() {} }] }) as unknown as MediaStream,
    loadSounds: async () => {
      if (soundFailure === "load") throw new Error("Sound file unavailable");
      return { on, off };
    },
  });
  return { capture, events, acknowledge: () => acknowledge(), endSound: () => sources.at(-1)?.onended?.() };
}

test("release captures its tail before flushing and plays off only after tracks stop", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = recordingHarness();
  await h.capture.start();
  assert.deepEqual(h.events, ["on"]);
  const finishing = h.capture.finish();
  assert.equal(h.capture.finish(), finishing, "Duplicate releases must share the drain");
  context.mock.timers.tick(499);
  await Promise.resolve();
  assert.deepEqual(h.events, ["on"]);
  context.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(h.events, ["on", "flush"]);
  h.acknowledge();
  await Promise.resolve();
  assert.deepEqual(h.events, ["on", "flush", "stopped", "off"]);
  h.endSound();
  await finishing;
  assert.equal(h.events.at(-1), "closed");
});

test("cancelling during release delay stops immediately and prevents a late flush", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = recordingHarness();
  await h.capture.start();
  const finishing = h.capture.finish();
  const cancelling = h.capture.cancel();
  assert.deepEqual(h.events, ["on", "stopped", "off"]);
  h.endSound();
  await Promise.all([finishing, cancelling]);
  context.mock.timers.tick(500);
  assert.deepEqual(h.events, ["on", "stopped", "off", "closed"]);
});

for (const failure of ["load", "play"] as const) {
  test(`sound ${failure} failure warns without preventing recording or cleanup`, async context => {
    const warning = context.mock.method(console, "warn", () => {});
    const h = recordingHarness(failure);
    assert.equal(await h.capture.start(), true);
    await h.capture.cancel();
    assert.deepEqual(h.events, ["stopped", "closed"]);
    assert.ok(warning.mock.callCount() > 0);
  });
}
