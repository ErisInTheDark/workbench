/*
 * No exports. Replay local PCM16 WAV through the installed recogniser without a model turn.
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 3) throw new Error("Use node scripts/replay-voice.mjs <audio.wav>");
const audio = path.resolve(process.argv[2]);
const descriptor = JSON.parse(await fs.readFile(path.join(root, ".workbench/native-voice/runtime.json"), "utf8"));
if (descriptor.version !== 1 || descriptor.platform !== process.platform || descriptor.arch !== process.arch
  || typeof descriptor.executable !== "string" || !path.isAbsolute(descriptor.executable)
  || typeof descriptor.modelDirectory !== "string" || !path.isAbsolute(descriptor.modelDirectory)) {
  throw new Error("Build a matching native voice runtime before replay.");
}

const wav = await fs.open(audio, "r");
let data;
try {
  const size = (await wav.stat()).size;
  const read = async (position, length) => {
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const result = await wav.read(bytes, offset, length - offset, position + offset);
      if (!result.bytesRead) throw new Error("Truncated WAV file.");
      offset += result.bytesRead;
    }
    return bytes;
  };
  const header = await read(0, 12);
  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8) !== "WAVE") {
    throw new Error("Expected a RIFF WAV recording.");
  }
  const end = header.readUInt32LE(4) + 8;
  if (end > size) throw new Error("WAV recording is not finalised.");
  let formatValid = false;
  for (let offset = 12; offset + 8 <= end;) {
    const chunk = await read(offset, 8);
    const name = chunk.toString("ascii", 0, 4);
    const length = chunk.readUInt32LE(4);
    const start = offset + 8;
    if (start + length > end) throw new Error("Invalid WAV chunk.");
    if (name === "fmt ") {
      if (length < 16) throw new Error("Invalid WAV format.");
      const format = await read(start, 16);
      formatValid = format.readUInt16LE(0) === 1 && format.readUInt16LE(2) === 1
        && format.readUInt32LE(4) === 16000 && format.readUInt32LE(8) === 32000
        && format.readUInt16LE(12) === 2 && format.readUInt16LE(14) === 16;
    } else if (name === "data") {
      if (data) throw new Error("Multiple WAV data chunks are unsupported.");
      data = { start, length };
    }
    offset = start + length + (length % 2);
  }
  if (!formatValid || !data?.length || data.length % 2) throw new Error("Replay needs non-empty 16 kHz mono PCM16 WAV.");
} finally { await wav.close(); }

const loadedAt = performance.now();
const ready = Promise.withResolvers();
const transportFailure = Promise.withResolvers();
const child = spawn(descriptor.executable, [], {
  cwd: path.dirname(descriptor.executable), windowsHide: true, stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, WORKBENCH_VOICE_MODEL_DIR: descriptor.modelDirectory },
});
const exited = new Promise(resolve => {
  child.once("error", error => ready.reject(error));
  child.once("close", (code, signal) => {
    ready.reject(new Error("Recogniser exited before readiness."));
    resolve({ code, signal });
  });
});
const lines = createInterface({ input: child.stdout });
child.stdin.on("error", transportFailure.reject);
lines.on("error", transportFailure.reject);
let startedAt = 0;
let firstTextMs = null;
let finished = false;
let latest = "";
const write = value => new Promise((resolve, reject) => {
  child.stdin.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve());
});
async function send() {
  await ready.promise;
  await write({ type: "start", sessionId: "replay" });
  const input = createReadStream(audio, { start: data.start, end: data.start + data.length - 1, highWaterMark: 3200 });
  for await (const frame of input) await write({ type: "audio", sessionId: "replay", pcm: frame.toString("base64") });
  await write({ type: "finish", sessionId: "replay" });
}
async function receive() {
  for await (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === "ready") {
      startedAt = performance.now();
      console.log(JSON.stringify({ pid: child.pid, modelDirectory: descriptor.modelDirectory, loadMs: startedAt - loadedAt }));
      ready.resolve();
    } else if (event.type === "error") throw new Error(event.message);
    else if (event.type === "transcript") {
      const delta = event.delta;
      if (firstTextMs === null && (delta.stableText || delta.unstableText)) firstTextMs = performance.now() - startedAt;
      latest = delta.inlineText;
      console.log(JSON.stringify(delta));
    } else if (event.type === "finished") {
      finished = true;
      const decodeMs = performance.now() - startedAt;
      const audioSeconds = data.length / 32000;
      console.log(JSON.stringify({ finalText: latest, audioSeconds, decodeMs, firstTextMs, realTimeFactor: decodeMs / 1000 / audioSeconds }));
      child.stdin.end();
    }
  }
  if (!finished) throw new Error("Recogniser closed without final drain.");
}
try {
  await Promise.race([transportFailure.promise, Promise.all([send(), receive(), exited.then(({ code, signal }) => {
    if (code !== 0) throw new Error(`Recogniser exited with ${signal ?? code}.`);
  })])]);
} finally {
  lines.close();
  child.stdin.destroy();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exited;
}
