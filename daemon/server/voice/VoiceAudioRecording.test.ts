/* No exports. Protect exact PCM retention, partial WAV finalisation and failure cleanup. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import VoiceAudioRecording from "./VoiceAudioRecording";

test("closing drains admitted samples into a playable WAV and rejects late frames", async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-audio-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const recording = new VoiceAudioRecording(directory);
  await recording.prepare();
  const frames = [Buffer.from([0, 128, 255, 127]), Buffer.from([42, 0])];
  const writes = frames.map(frame => recording.append(frame));
  const closing = recording.close();
  await assert.rejects(recording.append(Buffer.from([0, 0])), /ended/);
  await Promise.all([...writes, closing, recording.close()]);
  const wav = await fs.readFile(path.join(directory, "audio.wav"));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.deepEqual(wav.subarray(44), Buffer.concat(frames));
});

test("a failed PCM write remains a failure but closes a valid completed prefix", async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-audio-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const open = fs.open;
  let closed = false;
  context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    const write = file.write.bind(file);
    const close = file.close.bind(file);
    context.mock.method(file, "write", async (buffer: Buffer, offset: number, length: number, position: number) => {
      if (position >= 46) throw new Error("disk write failed");
      return write(buffer, offset, length, position);
    });
    context.mock.method(file, "close", async () => { closed = true; await close(); });
    return file;
  });
  const recording = new VoiceAudioRecording(directory);
  await recording.prepare();
  const pcm = Buffer.from([42, 0]);
  await recording.append(pcm);
  await assert.rejects(recording.append(pcm), /disk write failed/);
  await assert.rejects(recording.close(), /disk write failed/);
  assert.equal(closed, true);
  const wav = await fs.readFile(path.join(directory, "audio.wav"));
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("recording never overwrites an existing artifact and creation failure survives close", async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-audio-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "audio.wav");
  await fs.writeFile(file, "existing");
  const recording = new VoiceAudioRecording(directory);
  await assert.rejects(recording.prepare(), { code: "EEXIST" });
  await assert.rejects(recording.close(), { code: "EEXIST" });
  assert.equal(await fs.readFile(file, "utf8"), "existing");
});
