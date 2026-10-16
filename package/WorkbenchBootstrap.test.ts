/*
 * No production exports. Tests installation consent, incomplete-install resume and runtime handoff.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import test from "node:test";
import WorkbenchBootstrap from "./WorkbenchBootstrap.mjs";
import resolveWorkbenchDataRoot from "./workbench-data-root.mjs";

async function fixture(context, options = {}) {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-bootstrap-");
  const home = temporary.path;
  context.after(() => temporary.dispose());
  const checkout = path.join(home, "programs", "wb");
  const calls = [];
  const prompts = [];
  const locationDefaults = [];
  const output = [];
  const header = { pinned: false };
  const prompt = {
    choose: async question => { prompts.push(question); return "Let's go!"; },
    location: async (_label, fallback) => { prompts.push("location"); locationDefaults.push(fallback); return checkout; },
    withHeader: async task => {
      header.pinned = true;
      try { return await task(); }
      finally { header.pinned = false; }
    },
    ...options.prompt,
  };
  const commands = {
    async run(command, args, config) {
      calls.push({ command, args, config, pinned: header.pinned });
      if (command === "git" && args[0] === "clone") {
        await fs.mkdir(path.join(checkout, "scripts"), { recursive: true });
        await fs.mkdir(path.join(checkout, "cli"), { recursive: true });
        await fs.mkdir(path.join(checkout, ".git"));
        await fs.writeFile(path.join(checkout, "package.json"), '{"name":"workbench-root"}');
        await fs.writeFile(path.join(checkout, "scripts", "install.mjs"), "");
        await fs.writeFile(path.join(checkout, "cli", "dispatch.mjs"), "");
        await fs.writeFile(path.join(checkout, "wb"), "");
      }
      if (command === "git" && args[0] === "status") {
        try {
          await fs.access(path.join(checkout, "user-edit"));
          config.output.write("?? user-edit\n");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    },
  };
  const bootstrap = new WorkbenchBootstrap({
    home,
    packageRoot: path.join(home, "npm-cache", "package"),
    environment: {},
    write: text => output.push(text),
    ...options,
    prompt,
    commands,
    toolchain: {
      ensure: async () => {},
      runNode: async (_root, entry, args = [], config = {}) => commands.run(process.execPath, [entry, ...args], config),
    },
    registration: { prepare: async () => {}, register: async () => {} },
  });
  const dataRoot = resolveWorkbenchDataRoot({ homeDirectory: home, environment: options.environment ?? {} });
  const registry = path.join(dataRoot, "installation", "installation.json");
  return { bootstrap, home, dataRoot, registry, checkout, calls, prompts, locationDefaults, output };
}

const clones = f => f.calls.filter(call => call.command === "git" && call.args[0] === "clone").length;
const record = async f => JSON.parse(await fs.readFile(f.registry, "utf8"));
async function writeRecord(f, phase) {
  await fs.mkdir(path.dirname(f.registry), { recursive: true });
  await fs.writeFile(f.registry,
    JSON.stringify({ version: 1, root: f.checkout, phase }));
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

test("missing vp is provisioned after consent instead of rejected as a prerequisite", async context => {
  const f = await fixture(context);
  const original = f.bootstrap.commands.run;
  f.bootstrap.commands.run = async (command, args, config) => {
    if (command === "vp" && args[0] === "--version") {
      throw Object.assign(new Error("spawn vp ENOENT"), { code: "ENOENT" });
    }
    return original(command, args, config);
  };
  let provisioned = false;
  f.bootstrap.toolchain = {
    ensure: async () => {
      assert.ok(f.prompts.length > 0, "toolchain provisioning requires consent");
      provisioned = true;
    },
    runNode: async (_root, entry, args = [], config = {}) => original(process.execPath, [entry, ...args], config),
  };
  await f.bootstrap.run([]);
  assert.equal(provisioned, true);
  assert.equal((await record(f)).phase, "ready");
});

test("registration retains the original environment and follows checkout preparation", async context => {
  const f = await fixture(context);
  const events = [];
  const original = f.bootstrap.commands.run;
  f.bootstrap.commands.run = async (command, args, config) => {
    if (args.includes("--prepare")) events.push("build");
    return original(command, args, config);
  };
  f.bootstrap.registration = {
    prepare: async () => { events.push("registration-preflight"); },
    register: async root => { assert.equal(root, f.checkout); events.push("register"); },
  };
  await f.bootstrap.run([]);
  assert.deepEqual(events, ["registration-preflight", "build", "register"]);
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
  assert.equal((await record(f)).phase, "ready");
  await assert.rejects(fs.access(path.join(f.home, ".workbench")), { code: "ENOENT" });
  assert.equal(f.calls.filter(call => call.command === "git" && call.args[0] === "clone").length, 1);
  assert.equal(f.calls.find(call => call.command === "git" && call.args[0] === "clone").args.at(-1), f.checkout);
  assert.ok(f.output.some(line => line.includes(f.checkout)));
  const setup = f.calls.findIndex(call => call.command === process.execPath && call.args.includes("--prepare"));
  assert.ok(setup >= 0);
  assert.equal(f.calls.some(call => call.command === "vp" && call.args[0] === "env"), false);
  // Setup prompts need the caller's terminal; piped stdio makes them refuse.
  assert.equal(f.calls.find(call => call.args.includes("--connect"))?.config?.interactive, true);
  // The header owns the terminal during the build, then must release it before setup prompts.
  assert.ok(f.calls[setup].pinned && f.calls.find(call => call.args[0] === "clone")?.pinned);
  assert.equal(f.calls.find(call => call.args.includes("--connect"))?.pinned, false);
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

test("an overridden data root owns installation state across bootstrap invocations", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-bootstrap-data-");
  context.after(() => temporary.dispose());
  const environment = { WORKBENCH_DATA_ROOT: path.join(temporary.path, "custom data") };
  const f = await fixture(context, { environment });
  await f.bootstrap.run([]);
  assert.deepEqual(await record(f), { version: 1, root: f.checkout, phase: "ready" });
  await assert.rejects(fs.access(path.join(f.home, ".workbench")), { code: "ENOENT" });

  const next = new WorkbenchBootstrap({
    home: f.home,
    environment,
    packageRoot: path.join(f.home, "npm-cache", "package"),
    commands: f.bootstrap.commands,
    prompt: { choose: async () => { assert.fail("an installed checkout must not prompt"); } },
  });
  f.calls.length = 0;
  await next.run(["view"]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[0], path.join(f.checkout, "cli", "dispatch.mjs"));
});

test("a deleted ready checkout is reinstalled at its recorded location", async context => {
  const f = await fixture(context);
  await f.bootstrap.run([]);
  await fs.rm(f.checkout, { recursive: true });
  f.calls.length = 0;
  f.prompts.length = 0;

  await f.bootstrap.run([]);

  assert.equal(f.calls.filter(call => call.command === "git" && call.args[0] === "clone").length, 1);
  assert.equal(f.calls.find(call => call.command === "git" && call.args[0] === "clone")?.args.at(-1), f.checkout);
  assert.equal(f.prompts.length, 2);
  assert.equal(f.prompts[1], "location");
  assert.deepEqual(
    await record(f),
    { version: 1, root: f.checkout, phase: "ready" },
  );
});

test("an invalid ready checkout is preserved rather than replaced", async context => {
  const f = await fixture(context);
  await fs.mkdir(f.checkout, { recursive: true });
  await fs.writeFile(path.join(f.checkout, "keep"), "user");
  await writeRecord(f, "ready");

  await assert.rejects(f.bootstrap.run([]), /restore or repair/i);

  assert.equal(await fs.readFile(path.join(f.checkout, "keep"), "utf8"), "user");
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.calls, []);
});

test("an unrelated destination is never overwritten", async context => {
  const f = await fixture(context);
  await fs.mkdir(f.checkout, { recursive: true });
  await fs.writeFile(path.join(f.checkout, "keep"), "user");
  await assert.rejects(f.bootstrap.run([]), /empty|already exists/i);
  assert.equal(await fs.readFile(path.join(f.checkout, "keep"), "utf8"), "user");
  assert.ok(f.calls.every(call => call.args[0] === "--version"));
});

test("failed setup resumes in the recorded checkout after consent without recloning", async context => {
  const f = await fixture(context);
  const original = f.bootstrap.commands.run;
  let fail = true;
  f.bootstrap.commands.run = async (command, args, config) => {
    if (args.includes("--prepare") && fail) {
      await fs.writeFile(path.join(f.checkout, "user-edit"), "keep");
      throw new Error("build failed");
    }
    return original(command, args, config);
  };
  await assert.rejects(f.bootstrap.run([]), /build failed/);
  assert.equal((await record(f)).phase, "setup");
  fail = false;
  f.prompts.length = 0;
  f.locationDefaults.length = 0;

  await f.bootstrap.run([]);

  assert.equal(clones(f), 1);
  assert.ok(f.prompts[0].includes(`Resuming incomplete install at ${f.checkout}.`));
  assert.deepEqual(f.locationDefaults, [f.checkout]);
  assert.equal(await fs.readFile(path.join(f.checkout, "user-edit"), "utf8"), "keep");
  assert.equal((await record(f)).phase, "ready");
  assert.equal(f.calls.find(call => call.args.includes("--welcome"))?.config?.interactive, true);
});

test("a location chosen before provisioning fails becomes the next default", async context => {
  const f = await fixture(context);
  let fail = true;
  f.bootstrap.toolchain.ensure = async () => { if (fail) throw new Error("toolchain failed"); };
  await assert.rejects(f.bootstrap.run([]), /toolchain failed/);
  assert.deepEqual(await record(f), { version: 1, root: f.checkout, phase: "cloning" });
  fail = false;
  f.locationDefaults.length = 0;

  await f.bootstrap.run([]);

  assert.deepEqual(f.locationDefaults, [f.checkout]);
  assert.equal(clones(f), 1);
  assert.equal((await record(f)).phase, "ready");
});

test("resuming into a missing recorded checkout clones it", async context => {
  const f = await fixture(context);
  await writeRecord(f, "setup");
  await f.bootstrap.run([]);
  assert.equal(clones(f), 1);
  assert.equal((await record(f)).phase, "ready");
});

test("resuming into an unusable nonempty checkout stops and preserves it", async context => {
  const f = await fixture(context);
  await writeRecord(f, "cloning");
  await fs.mkdir(f.checkout, { recursive: true });
  await fs.writeFile(path.join(f.checkout, "keep"), "partial");
  await assert.rejects(f.bootstrap.run([]), /empty/i);
  assert.equal(await fs.readFile(path.join(f.checkout, "keep"), "utf8"), "partial");
  assert.equal((await record(f)).root, f.checkout);
  assert.equal(clones(f), 0);
});

test("cancelling a resume preserves the record and checkout", async context => {
  const f = await fixture(context);
  await fs.mkdir(f.checkout, { recursive: true });
  await writeRecord(f, "cloning");
  f.bootstrap.prompt.choose = async question => {
    f.prompts.push(question);
    return "Cancel";
  };
  await assert.rejects(f.bootstrap.run([]), { name: "AbortError" });
  assert.equal(f.prompts.length, 1);
  assert.ok(f.prompts[0].includes(`Resuming incomplete install at ${f.checkout}.`));
  await fs.access(f.checkout);
  assert.equal((await record(f)).phase, "cloning");
  assert.equal(clones(f), 0);
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
      toolchain: { ensure: async () => {} },
      registration: { prepare: async () => {}, register: async () => {} },
      prompt: { choose: async () => "Let's go!", location: async () => root, withHeader: task => task() },
      commands: { run: async (command, args) => {
        if (command === "git" && args[0] === "clone") {
          await fs.mkdir(path.join(root, "scripts"), { recursive: true });
          await fs.mkdir(path.join(root, "cli"), { recursive: true });
          await fs.mkdir(path.join(root, ".git"));
          await fs.writeFile(path.join(root, "package.json"), '{"name":"workbench-root"}');
          await fs.writeFile(path.join(root, "wb"), "");
          await fs.writeFile(path.join(root, "scripts/install.mjs"), "");
          await fs.writeFile(path.join(root, "cli/dispatch.mjs"), "");
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
  assert.equal(clones(f), 0);
  assert.ok(f.prompts[0].includes(`Resuming incomplete install at ${f.checkout}.`));
  assert.equal((await record(f)).phase, "ready");
});
