/*
 * No exports. Repair tests protect durable phase recovery and the dependency recovery ladder.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runRepair } from "./update.mjs";
import { InstallationRepairJournalSchema, type InstallationRepairJournal } from "../shared/workbench/installation-update.ts";
import { isRepairPending, readJournal, resolveDataRoot, writeJournal } from "./update-journal.mjs";
import resolveWorkbenchDataRoot from "../shared/workbench-data-root.ts";

const fromSha = "a".repeat(40);
const toSha = "b".repeat(40);

function fixture(phase: InstallationRepairJournal["phase"] = "pending", failures: string[] = [], rollback = true) {
  let journal: InstallationRepairJournal = {
    version: 1, id: "3a343847-c6cf-4c35-97f0-71873090a8da", phase,
    fromSha: rollback ? fromSha : null, toSha, logPath: "/repo/.workbench/logs/update.log",
    lastError: null, failure: null, createdAt: 1, updatedAt: 1,
  };
  const events: string[] = [];
  const options = {
    root: "/repo", dataRoot: "/data", now: () => 2,
    readJournal: async () => journal,
    writeJournal: async (next: typeof journal) => {
      InstallationRepairJournalSchema.parse(next);
      journal = structuredClone(next);
      events.push(`phase:${next.phase}`);
    },
    log: async (line: string) => { events.push(`log:${line}`); },
    stop: async () => { events.push("stop"); },
    clean: async () => { events.push("clean"); },
    commands: { run: async (command: string, args: string[]) => {
      events.push(`${command} ${args.join(" ")}`);
      const failure = failures.shift();
      if (failure) throw new Error(failure);
    } },
  };
  return { options, events, journal: () => journal };
}

test("repair persists each recovery rung and reports recovered failures", async () => {
  const f = fixture("pending", ["install failed", "", "rollback install failed"]);
  const result = await runRepair(f.options);
  assert.ok(result);
  assert.equal(result.phase, "done");
  assert.ok(result.failure);
  assert.deepEqual(f.events.filter(e => /^(stop|clean|vp |git )/u.test(e)), [
    "stop", "vp install", `git reset --keep ${fromSha}`, "vp install", "clean", "vp install",
  ]);
});

test("no rollback sha skips rollback, and the next launch retries a stranded repair from clean install", async () => {
  const f = fixture("pending", ["first failed", "clean failed"], false);
  assert.equal((await runRepair(f.options))?.phase, "stranded");
  assert.equal(f.journal().lastError, "clean failed");
  assert.equal(f.events.some(e => e.startsWith("git ")), false);
  const before = f.events.length;
  assert.equal((await runRepair(f.options))?.phase, "done");
  assert.deepEqual(f.events.slice(before).filter(e => /^(stop|clean|vp |git )/u.test(e)), ["stop", "clean", "vp install"]);
  // Nothing was rolled back, so the app has no failed update to hand to an agent.
  assert.equal(f.journal().failure, null);
});

for (const phase of ["pending", "stopping", "installing", "rolling-back", "clean-installing"] as const) {
  test(`repair resumes ${phase} only after confirming processes stopped`, async () => {
    const f = fixture(phase);
    assert.equal((await runRepair(f.options))?.phase, "done");
    const work = f.events.filter(e => /^(stop|clean|vp |git )/u.test(e));
    assert.equal(work[0], "stop");
    assert.equal(work.includes("clean"), phase === "clean-installing");
    assert.equal(work.some(e => e.startsWith("git ")), phase === "rolling-back");
  });
}

test("locked install retries once only after a second stop confirmation", async () => {
  const f = fixture("pending", ["EPERM: locked file", ""]);
  assert.equal((await runRepair(f.options))?.phase, "done");
  assert.deepEqual(f.events.filter(e => /^(stop|vp )/u.test(e)), [
    "stop", "vp install", "stop", "vp install",
  ]);
  assert.equal(f.journal().failure, null);
});

test("failed process stop strands without installing", async () => {
  const f = fixture();
  f.options.stop = async () => { throw new Error("host stop failed"); };
  assert.equal((await runRepair(f.options))?.phase, "stranded");
  assert.equal(f.events.some(e => e.startsWith("vp ")), false);
});

test("explicit repair restarts stranded recovery at clean install", async () => {
  const f = fixture("stranded");
  assert.equal((await runRepair({ ...f.options, force: true }))?.phase, "done");
  assert.deepEqual(f.events.filter(e => /^(stop|clean|vp |git )/u.test(e)), ["stop", "clean", "vp install"]);
});

test("explicit repair recovers from an unreadable journal and keeps it for inspection", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-repair-corrupt-");
  context.after(() => temporary.dispose());
  const dataRoot = path.join(temporary.path, "data");
  await fs.mkdir(path.join(dataRoot, "update"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "update", "journal.json"), "{ not json");
  const events: string[] = [];
  const result = await runRepair({
    root: temporary.path, dataRoot, force: true, now: () => 5,
    log: async (line: string) => { events.push(line); },
    stop: async () => {}, clean: async () => { events.push("clean"); },
    commands: { run: async (command: string) => { events.push(command); } },
  });
  assert.equal(result?.phase, "done");
  assert.deepEqual(events.filter(e => e === "clean" || e === "vp"), ["clean", "vp"]);
  assert.ok((await fs.readdir(path.join(dataRoot, "update"))).includes("journal.json.invalid-5"));
});

test("a resumed rollback without a sha proceeds to clean repair", async () => {
  const f = fixture("rolling-back", [], false);
  assert.equal((await runRepair(f.options))?.phase, "done");
  assert.deepEqual(f.events.filter(e => /^(stop|clean|vp |git )/u.test(e)), ["stop", "clean", "vp install"]);
});

test("publication barrier retires independent roots and waits for their exit", async () => {
  const f = fixture();
  const pids = new Set([91, 92]);
  let slept = false;
  const files = {
    readFile: async (filename: string) => {
      filename = filename.replaceAll("\\", "/");
      if (filename.includes("/service/")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return JSON.stringify({ pid: filename.includes("/app/") ? 91 : 92 });
    },
  };
  const commands = { run: async () => { assert.equal(pids.size, 0); f.events.push("install"); } };
  const result = await runRepair({
    ...f.options, stop: undefined, files, commands,
    alive: (pid: number) => pids.has(pid),
    verify: async () => {},
    quitApp: async (endpoint: { pid: number }) => { f.events.push(`terminate:${endpoint.pid}`); },
    terminate: async (pid: number) => { f.events.push(`terminate:${pid}`); },
    sleep: async () => { slept = true; pids.clear(); },
  });
  assert.ok(result);
  assert.equal(result.phase, "done");
  assert.equal(slept, true);
  assert.ok(f.events.indexOf("terminate:92") < f.events.indexOf("install"));
});

test("new process publications during shutdown strand before dependency writes", async () => {
  const f = fixture();
  let appReads = 0;
  const files = { readFile: async (filename: string) => {
    filename = filename.replaceAll("\\", "/");
    if (!filename.includes("/app/")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return JSON.stringify({ pid: ++appReads === 1 ? 91 : 93 });
  } };
  const result = await runRepair({ ...f.options, stop: undefined, files,
    alive: () => true, verify: async () => {}, quitApp: async () => {},
    terminate: async () => {}, sleep: async () => {} });
  assert.ok(result);
  assert.equal(result.phase, "stranded");
  assert.match(result.lastError!, /restarted during dependency repair/u);
  assert.equal(f.events.some(e => e.startsWith("vp ")), false);
});

test("journal boundary rejects malformed data and publishes validated journals atomically", async () => {
  const f = fixture();
  let disk = "";
  const events: string[] = [];
  const files = {
    mkdir: async () => {},
    readFile: async () => disk,
    writeFile: async (filename: string, text: string) => { events.push(`write:${filename}`); disk = text; },
    rename: async (source: string, destination: string) => { events.push(`rename:${source}:${destination}`); },
  };
  disk = "{";
  await assert.rejects(readJournal("/data", files), /invalid JSON/u);
  disk = '{"phase":"done"}';
  await assert.rejects(readJournal("/data", files), /journal is invalid/u);
  for (const phase of ["pending", "stopping", "installing", "rolling-back", "clean-installing", "done", "stranded"] as const) {
    await writeJournal({ ...f.journal(), phase }, "/data", files);
    const read = await readJournal("/data", files);
    InstallationRepairJournalSchema.parse(read);
    assert.equal(isRepairPending(read), phase !== "done");
  }
  assert.match(events[0], /\.tmp$/u);
  assert.match(events[1], /journal\.json$/u);
});

test("dependency-free data-root resolution mirrors the shared owner", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    for (const environment of [{}, { WORKBENCH_DATA_ROOT: "relative" }, { XDG_DATA_HOME: "/absolute" }, { XDG_DATA_HOME: "relative" }, { LOCALAPPDATA: "C:\\Data" }]) {
      const options = { platform, environment, homeDirectory: platform === "win32" ? "C:\\Home" : "/home" };
      assert.equal(resolveDataRoot(options), resolveWorkbenchDataRoot(options));
    }
  }
});

test("parallel boot entries share one repair and a dead lock owner is recoverable", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-repair-lock-");
  context.after(() => temporary.dispose());
  const dataRoot = temporary.path;
  const f = fixture();
  await writeJournal({ ...f.journal(), logPath: path.join(temporary.path, ".workbench", "logs", "update.log") }, dataRoot);
  const lock = path.join(dataRoot, "update", "repair.lock");
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, "owner-999999-3a343847-c6cf-4c35-97f0-71873090a8da"), "");
  let entered!: () => void;
  let release!: () => void;
  let contending!: () => void;
  const installing = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const contention = new Promise<void>(resolve => { contending = resolve; });
  let installs = 0;
  const options = {
    root: temporary.path, dataRoot,
    alive: (pid: number) => pid === process.pid,
    log: () => {}, stop: async () => {}, clean: async () => {},
    commands: { run: async () => { installs++; entered(); await finish; } },
  };
  const first = runRepair({ ...options, sleep: async () => {} });
  await installing;
  const second = runRepair({ ...options, sleep: async () => { contending(); await finish; } });
  await contention;
  assert.equal(installs, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(installs, 1);
  assert.equal(results.every(result => result?.phase === "done"), true);
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
});

test("clean repair removes workspace dependencies but preserves other checkout content", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-repair-clean-");
  context.after(() => temporary.dispose());
  const root = temporary.path;
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - app\n  - packages/*\n");
  for (const directory of ["node_modules", "app/node_modules", "packages/one/node_modules", "app/source"]) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
    await fs.writeFile(path.join(root, directory, "keep"), "");
  }
  let installs = 0;
  const result = await runRepair({
    root, dataRoot: path.join(root, "data"), force: true,
    log: () => {}, stop: async () => {},
    commands: { run: async () => {
      installs++;
      for (const directory of ["node_modules", "app/node_modules", "packages/one/node_modules"]) {
        await assert.rejects(fs.stat(path.join(root, directory)), { code: "ENOENT" });
      }
      assert.equal((await fs.stat(path.join(root, "app/source/keep"))).isFile(), true);
    } },
  });
  assert.equal(result?.phase, "done");
  assert.equal(installs, 1);
});

test("unverified process identities cannot be terminated or installed over", async () => {
  const f = fixture();
  let terminated = false;
  const files = { readFile: async (filename: string) => {
    if (filename.replaceAll("\\", "/").includes("/daemon/")) return '{"pid":91}';
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  } };
  const result = await runRepair({
    ...f.options, files, stop: undefined, alive: () => true,
    verify: async () => { throw new Error("identity does not match"); },
    terminate: async () => { terminated = true; },
  });
  assert.equal(result?.phase, "stranded");
  assert.equal(terminated, false);
  assert.equal(f.events.some(e => e.startsWith("vp ")), false);
});

test("all process bootstraps retry a stranded repair and end on one clear failure line without loading dependencies", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-repair-bootstrap-");
  context.after(() => temporary.dispose());
  const root = temporary.path;
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const entries = ["app/server/launch.mjs", "daemon/host/launch-node.mjs", "daemon/host/launch-foreground.mjs"];
  for (const filename of [...entries, "package/update.mjs", "package/update-journal.mjs", "package/SetupCommand.mjs"]) {
    await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await fs.copyFile(path.join(checkout, filename), path.join(root, filename));
  }
  const dataRoot = path.join(root, "data");
  const f = fixture("stranded");
  await writeJournal({ ...f.journal(), lastError: "fixture install failure",
    logPath: path.join(root, ".workbench", "logs", "update.log") }, dataRoot);
  for (const entry of entries) {
    await assert.rejects(promisify(execFile)(process.execPath, [path.join(root, entry)], {
      cwd: root, env: { ...process.env, WORKBENCH_DATA_ROOT: dataRoot,
        WORKBENCH_SERVICE_ACK_REQUIRED: "", WORKBENCH_THREAD_ID: "", CODEX_THREAD_ID: "" },
    }), error => {
      const failure = error as Error & { code: number; stderr: string };
      assert.equal(failure.code, entry.startsWith("app/") ? 1 : 78);
      // The tray's fatal dialog shows the last stderr line, so the failure must come last.
      assert.match(failure.stderr.trim().split(/\r?\n/u).at(-1) ?? "", /wb repair/u);
      assert.doesNotMatch(failure.stderr, /MODULE_NOT_FOUND/u);
      return true;
    });
  }
  // Managed threads never touch the journal.
  const untouched = (await readJournal(dataRoot))?.updatedAt;
  for (const entry of ["app/server/launch.mjs", "package/update.mjs"]) {
    await assert.rejects(promisify(execFile)(process.execPath, [path.join(root, entry)], {
      cwd: root, env: { ...process.env, WORKBENCH_DATA_ROOT: dataRoot, WORKBENCH_THREAD_ID: "fixture-managed" },
    }), error => {
      const failure = error as Error & { stderr: string };
      assert.match(failure.stderr, /Managed threads/u);
      return true;
    });
    assert.equal((await readJournal(dataRoot))?.updatedAt, untouched);
  }
});
