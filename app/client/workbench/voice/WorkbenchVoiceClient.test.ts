/* Exports: none. Protect controlled-value ownership and drain-before-unlock. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchVoiceClient from "./WorkbenchVoiceClient";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { VoiceSessionEvent } from "workbench-shared/workbench/voice/voice-session-contract";
import type VoiceCaptureController from "./VoiceCaptureController";

function harness() {
  let observe!: (event: VoiceSessionEvent) => void;
  let sessionId = "";
  let cancelled = 0;
  let finishes = 0;
  const changed: string[] = [];
  const captures: ConstructorParameters<typeof VoiceCaptureController>[0][] = [];
  const daemon = {
    onVoiceEvent(listener: typeof observe) { observe = listener; return () => {}; },
    onDisconnect() { return () => {}; },
    voice: {
      async start(input: { sessionId: string }) { sessionId = input.sessionId; },
      async audio() {},
      async finish() { finishes++; },
      async cancel() { cancelled++; },
    },
  } as unknown as WorkbenchDaemonClient;
  const client = new WorkbenchVoiceClient(daemon, "/voice.js", options => {
    captures.push(options);
    return ({
    async start(ready: Promise<void>) { await ready; return true; }, async cancel() {}, async finish() {},
  }) as unknown as VoiceCaptureController; });
  return { client, changed, captures, observe: (event: Omit<Extract<VoiceSessionEvent, { type: "document" }>, "sessionId">) => observe({ ...event, sessionId }),
    finish: () => observe({ type: "finished", sessionId }),
    get cancelled() { return cancelled; }, get finishes() { return finishes; },
    begin: () => client.begin({ id: "field", text: "old", change: text => changed.push(text) }) };
}
test("parent changes cancel voice and late document events cannot overwrite them", async () => {
  const h = harness();
  await h.begin();
  h.observe({ type: "document", revision: 1, text: "dictation" });
  h.client.reconcile("field", "dictation");
  assert.equal(h.cancelled, 0);
  h.client.reconcile("field", "manual replacement");
  h.observe({ type: "document", revision: 2, text: "late" });
  assert.deepEqual(h.changed, ["dictation"]);
  assert.equal(h.cancelled, 1);
  h.client.dispose();
});
test("release remains finishing until the daemon reports the complete drain", async () => {
  const h = harness();
  await h.begin();
  await h.client.finish("field");
  assert.equal(h.finishes, 1);
  assert.equal(h.client.getSnapshot().state, "finishing");
  h.finish();
  assert.equal(h.client.getSnapshot().state, "idle");
  h.client.dispose();
});

test("a retired microphone failure cannot cancel its replacement session", async () => {
  const h = harness();
  await h.begin();
  await h.client.cancel();
  await h.begin();
  h.captures[0]!.onError(new Error("old microphone ended"));
  assert.equal(h.client.getSnapshot().state, "listening");
  assert.equal(h.cancelled, 1);
  await h.client.cancel();
  h.client.dispose();
});

test("audio that exceeds the realtime queue budget fails instead of being silently dropped", async () => {
  const h = harness();
  await h.begin();
  for (let index = 0; index < 11; index++) h.captures[0]!.onFrame(new Int16Array(1600));
  assert.equal(h.client.getSnapshot().state, "failed");
  assert.equal(h.cancelled, 1);
  assert.equal(h.finishes, 0);
  h.client.dispose();
});
