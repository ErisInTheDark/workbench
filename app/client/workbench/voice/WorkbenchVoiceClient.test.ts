/* Exports: none. Protect controlled-value ownership and drain-before-unlock. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchVoiceClient from "./WorkbenchVoiceClient";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { VoiceSessionEvent, VoiceStart } from "workbench-shared/workbench/voice/voice-session-contract";
import type VoiceCaptureController from "./VoiceCaptureController";
import WorkbenchClientStateController from "../state/WorkbenchClientStateController";
import { encodeVoiceDocument } from "workbench-shared/workbench/voice/voice-document";

function harness(configured = true) {
  let observe!: (event: VoiceSessionEvent) => void;
  let disconnect!: () => void;
  let sessionId = "";
  let cancelled = 0;
  let finishes = 0;
  const changed: string[] = [];
  const starts: VoiceStart[] = [];
  const captures: ConstructorParameters<typeof VoiceCaptureController>[0][] = [];
  const daemon = {
    onVoiceEvent(listener: typeof observe) { observe = listener; return () => {}; },
    onDisconnect(listener: () => void) { disconnect = listener; return () => {}; },
    onReconnect() { return () => {}; },
    voice: {
      configuration: {
        async read() { return { selection: configured ? { kind: "custom", settings: {
          harness: "codex", model: "model", reasoningEffort: "none", agentPath: null, agentSource: null, serviceTier: null,
        } } : null }; },
        async write(value: { selection: object | null }) { configured = value.selection !== null; return { ok: true }; },
      },
      async prepare() {},
      async start(input: VoiceStart) { starts.push(input); sessionId = input.sessionId; },
      async audio() {},
      async finish() { finishes++; },
      async cancel() { cancelled++; },
    },
  } as unknown as WorkbenchDaemonClient;
  const preferences = new WorkbenchClientStateController();
  const snapshot = preferences.getSnapshot;
  preferences.getSnapshot = () => ({ ...snapshot(), schemaVersion: 13 });
  const client = new WorkbenchVoiceClient(daemon, "/voice.js", preferences, options => {
    captures.push(options);
    return ({
    async start(ready: Promise<void>) { await ready; return true; }, async cancel() {}, async finish() {},
  }) as unknown as VoiceCaptureController; });
  return { client, changed, starts, captures, disconnect: () => disconnect(), observe: (event: Omit<Extract<VoiceSessionEvent, { type: "document" }>, "sessionId">) => observe({ ...event, text: encodeVoiceDocument(event.text), sessionId }),
    malformed: () => observe({ type: "document", text: "missing marker", revision: 1, sessionId }),
    finish: () => observe({ type: "finished", sessionId }),
    get cancelled() { return cancelled; }, get finishes() { return finishes; },
    begin: async () => {
      await client.settings.ready;
      return client.begin({ id: "field", text: "old", change: text => changed.push(text) });
    } };
}

test("unconfigured voice cannot allocate capture or claim a field", async () => {
  const h = harness(false);
  await assert.rejects(h.begin(), /configure|select/i);
  assert.equal(h.captures.length, 0);
  assert.equal(h.client.getSnapshot().fieldId, null);
  h.client.dispose();
});

test("recording choice is admitted once per session and omitted when disabled", async () => {
  const h = harness();
  await h.begin();
  assert.equal("recordAudio" in h.starts[0]!, false);
  h.client.settings.setRecordAudio(true);
  assert.equal(h.cancelled, 0);
  await h.client.cancel();
  await h.begin();
  assert.equal(h.starts[1]?.recordAudio, true);
  h.client.settings.setRecordAudio(false);
  assert.equal(h.starts[1]?.recordAudio, true);
  await h.client.cancel();
  await h.begin();
  assert.equal("recordAudio" in h.starts[2]!, false);
  await h.client.cancel();
  h.client.dispose();
});

test("invalid model markers preserve the last valid document and stop capture", async () => {
  const h = harness();
  await h.begin();
  h.malformed();
  assert.deepEqual(h.changed, []);
  assert.equal(h.client.getSnapshot().state, "failed");
  assert.equal(h.cancelled, 1);
  h.client.dispose();
});

test("disconnect preserves the session failure while disabling voice admission", async () => {
  const h = harness();
  await h.begin();
  h.disconnect();
  assert.equal(h.client.getSnapshot().state, "failed");
  assert.equal(h.client.settings.enabled, false);
  assert.equal(h.cancelled, 1);
  h.client.dispose();
});

test("disabling settings cancels capture without undoing edits or admitting late documents", async () => {
  const h = harness();
  await h.begin();
  h.observe({ type: "document", revision: 1, text: "accepted" });
  await h.client.settings.disable();
  h.observe({ type: "document", revision: 2, text: "late" });
  assert.deepEqual(h.changed, ["accepted"]);
  assert.equal(h.cancelled, 1);
  assert.equal(h.client.getSnapshot().state, "idle");
  h.client.dispose();
});
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
