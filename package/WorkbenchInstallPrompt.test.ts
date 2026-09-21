/*
 * No production exports. Tests installation path editing and terminal ownership.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import WorkbenchInstallPrompt from "./WorkbenchInstallPrompt.mjs";

test("installation destinations append wb once, respecting directory boundaries", () => {
  const prompt = new WorkbenchInstallPrompt({ platform: "linux", cwd: "/projects" });
  assert.equal(prompt.destination("."), "/projects/wb");
  assert.equal(prompt.destination("/projects/"), "/projects/wb");
  assert.equal(prompt.destination("/projects/wb/"), "/projects/wb");
  assert.equal(prompt.destination("/projects/workbench"), "/projects/workbench");
  assert.equal(prompt.destination("/projects/mywb"), "/projects/mywb/wb");
  const windows = new WorkbenchInstallPrompt({ platform: "win32", cwd: "C:\\projects" });
  assert.equal(windows.destination("."), "C:\\projects\\wb");
  assert.equal(windows.destination("C:\\projects\\WORKBENCH\\"), "C:\\projects\\WORKBENCH");
});

function terminal() {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(value: boolean): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
  output.isTTY = true;
  output.columns = 100;
  const frames: string[] = [];
  output.on("data", (chunk) => frames.push(chunk.toString()));
  return { input, output, frames };
}

test("the automatic suffix never enters the editable input", async () => {
  const io = terminal();
  const prompt = new WorkbenchInstallPrompt({ ...io, platform: "linux", cwd: "/projects" });
  const result = prompt.location("Install location", "/projects");
  io.input.emit("keypress", "", { name: "end" });
  io.input.emit("keypress", "", { name: "right" });
  io.input.emit("keypress", "x", { name: "x" });
  io.input.emit("keypress", "", { name: "return" });
  assert.equal(await result, "/projectsx/wb");
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.listenerCount("keypress"), 0);
  assert.ok(io.frames.some((frame) => frame.includes("\u001b[2m/wb\u001b[22m")));
});

test("explicit workbench destination remains editable without a duplicate suffix", async () => {
  const io = terminal();
  const prompt = new WorkbenchInstallPrompt({ ...io, platform: "linux", cwd: "/projects" });
  const result = prompt.location("Install location", "/projects/workbench");
  io.input.emit("keypress", "", { name: "return" });
  assert.equal(await result, "/projects/workbench");
  assert.ok(!io.frames.some((frame) => frame.includes("\u001b[2m/wb")));
});

test("cancellation restores terminal state and never accepts installation", async () => {
  const io = terminal();
  const prompt = new WorkbenchInstallPrompt(io);
  const result = prompt.choose("Install?", ["Let's go!", "Cancel"]);
  io.input.emit("keypress", "\u0003", { name: "c", ctrl: true });
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.listenerCount("keypress"), 0);
});

test("noninteractive prompts refuse implicit consent", async () => {
  const prompt = new WorkbenchInstallPrompt({
    input: new PassThrough(),
    output: new PassThrough(),
  });
  await assert.rejects(prompt.choose("Install?", ["Let's go!", "Cancel"]), /interactive terminal/i);
});
