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
