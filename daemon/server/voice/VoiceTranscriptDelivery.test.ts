/* Exports: none. Protect revision coalescing and final ASR delivery. */
import assert from "node:assert/strict";
import test from "node:test";
import VoiceTranscriptDelivery from "./VoiceTranscriptDelivery";
import type { TranscriptDelta } from "workbench-shared/workbench/voice/voice-contract";
import type { SingleFileInput } from "workbench-shared/workbench/provider/provider-single-file";

function delta(revision: number, inlineText: string): TranscriptDelta {
  return { sessionId: "s", revision, segment: 0, isFinal: false, stableText: "", unstableText: inlineText,
    alternatives: [], hypotheses: [{ text: inlineText, tokens: [], timestamps: [], score: 0 }], inlineText };
}

test("coalesced revisions preserve complete context and final input follows admission", async () => {
  const sent: SingleFileInput[] = [];
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const delivery = new VoiceTranscriptDelivery(async input => {
    sent.push(input);
    if (sent.length === 1) await first;
  });
  delivery.accept(delta(1, "add"));
  delivery.accept(delta(2, "add unclaimed"));
  delivery.accept(delta(3, "add unclaimed dirt"));
  const finishing = delivery.finish();
  assert.equal(sent.length, 1);
  release();
  await finishing;
  assert.equal(sent.at(-1)?.final, true);
  assert.equal(sent.at(-1)?.transcript, "add unclaimed dirt");
  assert.deepEqual(sent.map(input => input.transcript), ["add", "add unclaimed dirt"]);
});

test("delivery failure remains observable through drain", async () => {
  const failures: Error[] = [];
  const delivery = new VoiceTranscriptDelivery(async () => { throw new Error("admission failed"); }, error => failures.push(error));
  delivery.accept(delta(1, "text"));
  await assert.rejects(delivery.finish(), /admission failed/);
  assert.equal(failures.length, 1);
});
