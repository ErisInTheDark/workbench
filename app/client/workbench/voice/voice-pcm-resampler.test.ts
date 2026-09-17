/* Exports: none. Protect resampling continuity and PCM saturation. */
import assert from "node:assert/strict";
import test from "node:test";
import VoicePcmResampler from "./voice-pcm-resampler";

function convert(rate: number, chunks: Float32Array[]) {
  const result: number[] = [];
  const resampler = new VoicePcmResampler(rate, frame => result.push(...frame));
  for (const chunk of chunks) resampler.push([chunk]);
  resampler.finish();
  return result;
}
test("arbitrary input chunk boundaries preserve resampled audio", () => {
  for (const rate of [16000, 44100, 48000]) {
    const signal = Float32Array.from({ length: rate }, (_, index) => Math.sin(index / 17) * 0.5);
    const chunks: Float32Array[] = [];
    for (let i = 0; i < signal.length; i += 127) chunks.push(signal.slice(i, i + 127));
    const whole = convert(rate, [signal]);
    assert.deepEqual(convert(rate, chunks), whole);
    assert.equal(whole.length, 16000);
  }
});
test("stereo mixes to mono and clips finite PCM", () => {
  const frames: number[] = [];
  const resampler = new VoicePcmResampler(16000, frame => frames.push(...frame));
  resampler.push([new Float32Array([3, -3, 1]), new Float32Array([3, -3, -1])]);
  resampler.finish();
  assert.deepEqual(frames, [32767, -32768, 0]);
});
