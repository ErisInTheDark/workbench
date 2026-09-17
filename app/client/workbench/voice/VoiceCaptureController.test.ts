/* Exports: none. Protect microphone cleanup around asynchronous browser permission. */
import assert from "node:assert/strict";
import test from "node:test";
import VoiceCaptureController from "./VoiceCaptureController";

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
