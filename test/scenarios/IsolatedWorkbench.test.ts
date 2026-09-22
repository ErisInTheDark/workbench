/* No exports. Tests protect scenario process retirement, diagnostic evidence, workspace cleanup and path containment. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";
import { captureTestOutput } from "../capture-test-output.mts";
import IsolatedWorkbench, {
  IsolatedWorkbenchSignalCleanup,
  removeIsolatedWorkbenchWorkspace,
} from "./IsolatedWorkbench";

async function runtime(
  context: TestContext,
  signal: AbortSignal,
  readinessSignal?: () => AbortSignal,
  programs?: { app: string; host: string },
) {
  captureTestOutput(context, process.stdout, text => text.startsWith("[scenario] "));
  captureTestOutput(context, process.stderr, text => text.startsWith("Scenario diagnostics retained: "));
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-scenario-owner-"));
  context.after(async () => await fs.rm(source, { force: true, recursive: true }));
  for (const directory of ["app/node_modules", "daemon/node_modules", "shared/node_modules",
    "instructions", "package", "node_modules", "test/scenarios"]) {
    await fs.mkdir(path.join(source, directory), { recursive: true });
  }
  await fs.writeFile(path.join(source, "package.json"), "{}");
  await fs.writeFile(path.join(source, ".gitignore"), ".workbench\nnode_modules\n");
  await fs.writeFile(path.join(source, "test/scenarios/isolated-shutdown.mjs"), "");
  if (programs) {
    // Only the loader is shared. The child programs and their data are private.
    await fs.symlink(path.resolve(import.meta.dirname, "../../node_modules/tsx"), path.join(source, "node_modules/tsx"), "junction");
    await fs.mkdir(path.join(source, "daemon/host"), { recursive: true });
    await fs.mkdir(path.join(source, "app/server"), { recursive: true });
    await fs.writeFile(path.join(source, "daemon/host/launch-node.mjs"), programs.host);
    await fs.writeFile(path.join(source, "app/server/index.ts"), programs.app);
    for (const directory of ["app", "daemon"]) await fs.writeFile(path.join(source, directory, "tsconfig.json"), "{}");
  }
  return await IsolatedWorkbench.create(source, signal, { codexIdentity: false, readinessSignal });
}

const hostProgram = `
  console.log("host-pid", process.pid);
  console.log("workbench-host-ready");
  process.on("message", message => {
    if (message.type === "workbench-scenario-close") process.exit(0);
  });
`;

test("owned host and app can stop and reopen without retaining old processes", async context => {
  const fixture = await runtime(context, context.signal, undefined, {
    host: hostProgram,
    app: `
      console.log("listening at http://127.0.0.1:12345");
      process.on("message", message => {
        if (message.type === "workbench-scenario-close") process.exit(0);
      });
    `,
  });
  try {
    for (let run = 0; run < 2; run += 1) {
      await fixture.startApp();
      const app = fixture.processIds.app;
      assert.ok(app);
      const host = Number((await fs.readFile(path.join(fixture.root, "service.log"), "utf8")).match(/host-pid (\d+)/gu)?.at(-1)?.split(" ")[1]);
      assert.ok(host);
      assert.equal((await fixture.stop()).app, 0);
      for (const pid of [host, app]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
  } finally {
    await fixture.close();
  }
});

test("readiness cancellation retires both real fixture processes and releases cleanup ownership", async context => {
  const deadline = new AbortController();
  const fixture = await runtime(context, context.signal, () => deadline.signal, {
    host: hostProgram,
    app: 'console.log("fixture-app-started"); process.on("message", () => {});',
  });
  try {
    const starting = fixture.startApp();
    const failed = assert.rejects(starting, /app readiness/u);
    await fixture.until(() => fixture.appOutput.includes("fixture-app-started"));
    const app = fixture.processIds.app;
    assert.ok(app);
    const host = Number((await fs.readFile(path.join(fixture.root, "service.log"), "utf8")).match(/host-pid (\d+)/u)?.[1]);
    assert.ok(host);
    deadline.abort(new Error("test-controlled readiness expiry"));
    await failed;
    await fixture.stop();
    for (const pid of [host, app]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(fixture.processIds, { app: undefined, daemon: undefined });
  } finally {
    await fixture.close();
  }
});

test("readiness expiry cancels later startup and retains the phase failure", async context => {
  const deadline = new AbortController();
  const fixture = await runtime(context, context.signal, () => deadline.signal);
  const reason = new Error("readiness expired");
  const waiting = fixture.phase("host readiness", async () => {
    deadline.abort(reason);
    return await new Promise<void>(() => {});
  });
  await assert.rejects(waiting, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, reason);
    assert.match(error.message, /host readiness/u);
    return true;
  });
  await assert.rejects(fixture.start(), error => error === reason);
  await assert.rejects(fixture.startApp(), error => error === reason);
  assert.deepEqual(fixture.processIds, { app: undefined, daemon: undefined });
  await fixture.close();
});

test("caller cancellation aborts readiness without waiting for its deadline", async context => {
  const caller = new AbortController();
  const fixture = await runtime(context, caller.signal, () => new AbortController().signal);
  const reason = new Error("caller cancelled");
  const waiting = fixture.phase("transcript readiness", async signal => {
    caller.abort(reason);
    await fixture.until(() => false, signal);
  });
  await assert.rejects(waiting, error => error instanceof Error && error.cause === reason);
  await fixture.close();
});

test("a completed phase's deadline cannot cancel later readiness", async context => {
  const first = new AbortController();
  const second = new AbortController();
  let count = 0;
  const fixture = await runtime(context, context.signal, () => (++count === 1 ? first : second).signal);
  await fixture.phase("first", async () => "ready");
  first.abort(new Error("retired deadline"));
  assert.equal(await fixture.phase("second", async signal => {
    signal.throwIfAborted();
    return "ready again";
  }), "ready again");
  await fixture.close();
});

test("failure diagnostics retain only run logs while the cloned workspace is removed", async context => {
  const fixture = await runtime(context, context.signal);
  fixture.markPhase("waiting for host");
  await fs.writeFile(path.join(fixture.root, "service.log"), "host evidence");
  await fs.writeFile(path.join(fixture.root, "workbench.sqlite3"), "private database");
  await fs.mkdir(path.join(fixture.root, "codex"));
  await fs.writeFile(path.join(fixture.root, "codex/auth.json"), "private identity");

  const diagnostics = await fixture.close({ preserveDiagnostics: true });

  assert.ok(diagnostics);
  assert.deepEqual((await fs.readdir(diagnostics)).sort(), ["scenario.log", "service.log"]);
  assert.equal(await fs.readFile(path.join(diagnostics, "service.log"), "utf8"), "host evidence");
  await assert.rejects(fs.stat(fixture.root), { code: "ENOENT" });
});

test("process signals settle every active scenario exactly once before exit", async () => {
  const signals = new EventEmitter();
  const exits: number[] = [];
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  let first = 0;
  let second = 0;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const cleanup = new IsolatedWorkbenchSignalCleanup(
    signals,
    code => {
      exits.push(code);
      resolveExit();
    },
  );
  cleanup.register(async () => {
    first += 1;
    await firstReleased;
  });
  cleanup.register(async () => {
    second += 1;
  });

  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual({ first, second, exits }, { first: 1, second: 1, exits: [] });
  releaseFirst();
  await exited;
  assert.deepEqual(exits, [130]);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("removes only the exact owned scenario workspace", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-scenario-cleanup-"));
  context.after(async () => await fs.rm(temporary, { force: true, recursive: true }));
  const fixtures = path.join(temporary, "test-runs");
  const root = path.join(fixtures, "wb-scenario-owned");
  const external = path.join(temporary, "external");
  await fs.mkdir(path.join(root, "codex", ".sandbox"), { recursive: true });
  await fs.mkdir(path.join(external, "secrets"), { recursive: true });
  await fs.writeFile(path.join(external, "secrets", "retained.txt"), "external");
  await fs.writeFile(path.join(external, "marker.json"), "external");
  await fs.writeFile(path.join(root, "codex", "auth.json"), "fixture");
  await fs.symlink(path.join(external, "secrets"), path.join(root, "codex", ".sandbox-secrets"),
    process.platform === "win32" ? "junction" : "dir");
  await fs.link(path.join(external, "marker.json"), path.join(root, "codex", ".sandbox", "setup_marker.json"));
  await fs.writeFile(path.join(root, "retained.txt"), "fixture");

  await removeIsolatedWorkbenchWorkspace(fixtures, root, true);

  await assert.rejects(fs.stat(root), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(external, "secrets", "retained.txt"), "utf8"), "external");
  assert.equal(await fs.readFile(path.join(external, "marker.json"), "utf8"), "external");
  await assert.rejects(
    removeIsolatedWorkbenchWorkspace(fixtures, path.join(temporary, "wb-scenario-foreign"), false),
    /direct child/u,
  );
});

test("failed setup removes its allocated scenario workspace", async (context) => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-scenario-setup-"));
  context.after(async () => await fs.rm(source, { force: true, recursive: true }));

  await assert.rejects(
    IsolatedWorkbench.create(source, AbortSignal.timeout(5_000), { codexIdentity: false }),
    /ENOENT/u,
  );

  assert.deepEqual(await fs.readdir(path.join(source, ".workbench", "test-runs")), []);
});
