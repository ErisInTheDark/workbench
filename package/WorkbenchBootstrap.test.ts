/*
 * No production exports. Tests installation consent, ownership and resumable setup.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import test from "node:test";
import WorkbenchBootstrap from "./WorkbenchBootstrap.mjs";

async function fixture(context, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wb-bootstrap-"));
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  const checkout = path.join(home, "programs", "wb");
  const calls = [];
  const prompts = [];
  const prompt = {
    choose: async () => { prompts.push("choose"); return "Let's go!"; },
    location: async () => { prompts.push("location"); return checkout; },
    ...options.prompt,
  };
  const commands = {
    async run(command, args, config) {
      calls.push({ command, args, config });
      if (command === "git" && args[0] === "clone") {
        await fs.mkdir(path.join(checkout, "package"), { recursive: true });
        await fs.writeFile(path.join(checkout, "package.json"), '{"name":"workbench-root"}');
        await fs.writeFile(path.join(checkout, "package", "setup.mjs"), "");
        await fs.writeFile(path.join(checkout, "wb"), "");
      }
    },
  };
  const bootstrap = new WorkbenchBootstrap({
    home,
    packageRoot: path.join(home, "npm-cache", "package"),
    environment: {},
    ...options,
    prompt,
    commands,
  });
  return { bootstrap, home, checkout, calls, prompts };
}

test("missing Git fails before consent or filesystem changes", async context => {
  const f = await fixture(context);
  f.bootstrap.commands.run = async (command, args) => {
    if (command === "git" && args[0] === "--version") {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    }
  };
  await assert.rejects(f.bootstrap.run([]), /git.*PATH/i);
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(await fs.readdir(f.home), []);
});

test("missing pnpm fails before destination selection or installation record", async context => {
  const f = await fixture(context);
  const original = f.bootstrap.commands.run;
  f.bootstrap.commands.run = async (command, args, config) => {
    if (command === "pnpm" && args[0] === "--version") {
      throw Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" });
    }
    return original(command, args, config);
  };
  await assert.rejects(f.bootstrap.run([]), /pnpm.*PATH/i);
  assert.deepEqual(f.prompts, ["choose"]);
  assert.deepEqual(await fs.readdir(f.home), []);
});

test("only human launch and connect may install, and refusal writes nothing", async context => {
  const f = await fixture(context, { prompt: { choose: async () => "Cancel" } });
  await assert.rejects(f.bootstrap.run(["shortcut"]), /not installed/i);
  await assert.rejects(f.bootstrap.run(["view", "daemon"]), /not installed/i);
  await assert.rejects(f.bootstrap.run(["view"]), /not installed/i);
  await assert.rejects(f.bootstrap.run([]), { name: "AbortError" });
  assert.ok(f.calls.every(call => call.args[0] === "--version"));
  assert.deepEqual(await fs.readdir(f.home), []);
  const managed = await fixture(context, { environment: { WORKBENCH_THREAD_ID: "managed" } });
  await assert.rejects(managed.bootstrap.run([]), /managed/i);
  await assert.rejects(managed.bootstrap.run(["view", "app"]), /managed/i);
  await assert.rejects(managed.bootstrap.run(["view"]), /managed/i);
  assert.deepEqual(managed.calls, []);
});

test("installation records the selected checkout and never clones it again", async context => {
  const f = await fixture(context);
  await f.bootstrap.run(["connect"]);
  assert.equal(f.calls.filter(call => call.command === "git" && call.args[0] === "clone").length, 1);
  assert.equal(f.calls.find(call => call.command === "git" && call.args[0] === "clone").args.at(-1), f.checkout);
  assert.ok(f.calls.some(call => call.args.includes("--connect")));
  f.calls.length = 0;
  await f.bootstrap.run([]);
  assert.equal(f.calls.filter(call => call.command === "git").length, 0);
  assert.ok(f.calls.some(call => call.args.some(arg => arg.endsWith("dispatch.mjs"))));
  f.calls.length = 0;
  await f.bootstrap.run(["view", "daemon"]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].config.interactive, true);
  assert.deepEqual(f.calls[0].args.slice(-2), ["view", "daemon"]);
  f.calls.length = 0;
  await f.bootstrap.run(["view"]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].config.interactive, true);
  assert.equal(f.calls[0].args.at(-1), "view");
});

test("an unrelated destination is never overwritten", async context => {
  const f = await fixture(context);
  await fs.mkdir(f.checkout, { recursive: true });
  await fs.writeFile(path.join(f.checkout, "keep"), "user");
  await assert.rejects(f.bootstrap.run([]), /empty|already exists/i);
  assert.equal(await fs.readFile(path.join(f.checkout, "keep"), "utf8"), "user");
  assert.ok(f.calls.every(call => call.args[0] === "--version"));
});

test("failed checkout setup is retried without recloning or resetting source", async context => {
  const f = await fixture(context);
  const original = f.bootstrap.commands.run;
  let fail = true;
  f.bootstrap.commands.run = async (command, args, config) => {
    if (args.includes("--prepare") && fail) throw new Error("build failed");
    return original(command, args, config);
  };
  await assert.rejects(f.bootstrap.run([]), /build failed/);
  await fs.writeFile(path.join(f.checkout, "user-edit"), "preserve");
  fail = false;
  f.bootstrap.commands.run = async (command, args, config) => {
    if (command === "git") throw new Error("Git should not be needed after cloning.");
    return original(command, args, config);
  };
  await f.bootstrap.run([]);
  assert.equal(f.calls.filter(call => call.command === "git" && call.args[0] === "clone").length, 1);
  assert.equal(await fs.readFile(path.join(f.checkout, "user-edit"), "utf8"), "preserve");
});

test("an abruptly exited installer cannot leave a permanent installation lock", async context => {
  const f = await fixture(context);
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "WorkbenchBootstrap.mjs")).href;
  const script = `
    import Bootstrap from ${JSON.stringify(moduleUrl)};
    import fs from "node:fs/promises";
    import path from "node:path";
    const root = ${JSON.stringify(f.checkout)};
    await new Bootstrap({
      home: ${JSON.stringify(f.home)},
      packageRoot: ${JSON.stringify(path.join(f.home, "cache", "package"))},
      environment: {},
      prompt: { choose: async () => "Let's go!", location: async () => root },
      commands: { run: async (command, args) => {
        if (command === "git" && args[0] === "clone") {
          await fs.mkdir(path.join(root, "package"), { recursive: true });
          await fs.writeFile(path.join(root, "package.json"), '{"name":"workbench-root"}');
          await fs.writeFile(path.join(root, "wb"), "");
          await fs.writeFile(path.join(root, "package/setup.mjs"), "");
        } else if (args.includes("--prepare")) {
          process.send("setup-entered");
          await new Promise(() => {});
        }
      } }
    }).run([]);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errorOutput = "";
  child.stderr.on("data", bytes => { errorOutput += bytes.toString(); });
  const exited = once(child, "exit");
  const entered = once(child, "message");
  const first = await Promise.race([
    entered.then(() => "entered"),
    exited.then(() => "exited"),
  ]);
  assert.equal(first, "entered", errorOutput);
  child.kill();
  await exited;
  await f.bootstrap.run([]);
  assert.equal(f.calls.filter(call => call.command === "git" && call.args[0] === "clone").length, 0);
});
