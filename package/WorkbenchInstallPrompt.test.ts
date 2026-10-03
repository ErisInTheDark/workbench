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

function terminal(rows?: number) {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(value: boolean): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows?: number };
  output.isTTY = true;
  output.columns = 100;
  if (rows !== undefined) output.rows = rows;
  const frames: string[] = [];
  output.on("data", (chunk) => frames.push(chunk.toString()));
  // Animation ticks are driven by hand; `stopped` records whether the prompt released its schedule.
  const animation = { ticks: [] as Array<() => void>, stopped: 0 };
  const schedule = (tick: () => void) => {
    animation.ticks.push(tick);
    return () => { animation.stopped++; };
  };
  return { input, output, frames, schedule, animation };
}

test("the cube animates in place and stops whenever the prompt settles", async () => {
  for (const settle of ["accept", "cancel"] as const) {
    const io = terminal(40);
    const prompt = new WorkbenchInstallPrompt(io);
    const result = prompt.choose("Install?", ["Let's go!", "Cancel"]);
    assert.equal(io.animation.ticks.length, 1);
    io.frames.length = 0;
    io.animation.ticks[0]!();
    const tick = io.frames.join("");
    assert.ok(tick.startsWith("\u001b7\u001b[H") && tick.endsWith("\u001b8"), "frames save and restore the prompt cursor");
    if (settle === "accept") {
      io.input.emit("keypress", "", { name: "return" });
      assert.equal(await result, "Let's go!");
    } else {
      io.input.emit("keypress", "\u0003", { name: "c", ctrl: true });
      await assert.rejects(result, { name: "AbortError" });
    }
    assert.equal(io.animation.stopped, 1);
    io.frames.length = 0;
    io.animation.ticks[0]!();
    assert.deepEqual(io.frames, [], "a late tick never draws over the restored terminal");
  }
});

test("a settled prompt stops reading so later child prompts receive the keys", async () => {
  for (const settle of ["accept", "cancel"] as const) {
    // Like a fresh process.stdin: neither flowing nor paused until someone reads it.
    const io = terminal();
    assert.equal(io.input.readableFlowing, null);
    const result = new WorkbenchInstallPrompt(io).choose("Install?", ["Let's go!", "Cancel"]);
    if (settle === "accept") {
      io.input.emit("keypress", "", { name: "return" });
      await result;
    } else {
      io.input.emit("keypress", "\u0003", { name: "c", ctrl: true });
      await assert.rejects(result, { name: "AbortError" });
    }
    assert.notEqual(io.input.readableFlowing, true);
  }
});

test("a pinned header always releases its scroll region, animation and interrupt handler", async () => {
  const interruptListeners = process.listenerCount("SIGINT");
  for (const outcome of ["resolve", "reject"] as const) {
    const io = terminal(40);
    const prompt = new WorkbenchInstallPrompt(io);
    let during = "";
    const result = prompt.withHeader(async () => {
      during = io.frames.join("");
      io.frames.length = 0;
      if (outcome === "reject") throw new Error("build failed");
      return "done";
    });
    if (outcome === "resolve") assert.equal(await result, "done");
    else await assert.rejects(result, /build failed/);
    assert.match(during, /\u001b\[\d+;40r/u, "output scrolls only below the header");
    assert.ok(during.includes("w o r k b e n c h"));
    assert.ok(io.frames.join("").includes("\u001b[r"), "the full-screen scroll region is restored");
    assert.equal(io.animation.stopped, 1);
    assert.equal(process.listenerCount("SIGINT"), interruptListeners);
    io.frames.length = 0;
    io.animation.ticks[0]!();
    assert.deepEqual(io.frames, [], "a late tick never draws over later output");
  }
});

test("a terminal too short for the cube shows the wordmark without animating or pinning", async () => {
  const io = terminal(12);
  const prompt = new WorkbenchInstallPrompt(io);
  const result = prompt.choose("Install?", ["Let's go!", "Cancel"]);
  assert.equal(io.animation.ticks.length, 0);
  assert.ok(io.frames.join("").includes("w o r k b e n c h"));
  io.input.emit("keypress", "", { name: "return" });
  await result;
  io.frames.length = 0;
  assert.equal(await prompt.withHeader(async () => "done"), "done");
  assert.deepEqual(io.frames, []);
  assert.equal(io.animation.ticks.length, 0);
});

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
  assert.ok(io.frames.join("").includes("\u001b[?1049h"));
  assert.ok(io.frames.join("").includes("\u001b[?1049l"));
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

test("choices are visible together and navigation accepts the highlighted choice", async () => {
  const io = terminal();
  const prompt = new WorkbenchInstallPrompt(io);
  const result = prompt.choose("Install?", ["Let's go!", "Cancel"]);
  const initial = io.frames.join("");
  assert.ok(initial.includes("Let's go!"));
  assert.ok(initial.includes("Cancel"));
  io.input.emit("keypress", "", { name: "down" });
  io.input.emit("keypress", "", { name: "return" });
  assert.equal(await result, "Cancel");
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.listenerCount("keypress"), 0);
  assert.ok(io.frames.join("").includes("\u001b[?1049h"));
  assert.ok(io.frames.join("").includes("\u001b[?1049l"));
});

test("cancellation restores terminal state and never accepts installation", async () => {
  const io = terminal();
  const prompt = new WorkbenchInstallPrompt(io);
  const result = prompt.choose("Install?", ["Let's go!", "Cancel"]);
  io.input.emit("keypress", "\u0003", { name: "c", ctrl: true });
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.listenerCount("keypress"), 0);
  assert.ok(io.frames.join("").includes("\u001b[?1049l"));
});

test("a prompt rendering failure restores the terminal", async () => {
  const io = terminal();
  const prompt = new WorkbenchInstallPrompt(io);
  await assert.rejects(prompt.interact(() => { throw new Error("render failed"); }, () => {}), /render failed/);
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.listenerCount("keypress"), 0);
  assert.ok(io.frames.join("").includes("\u001b[?1049l"));
});

test("noninteractive prompts refuse implicit consent", async () => {
  const prompt = new WorkbenchInstallPrompt({
    input: new PassThrough(),
    output: new PassThrough(),
  });
  await assert.rejects(prompt.choose("Install?", ["Let's go!", "Cancel"]), /interactive terminal/i);
});
