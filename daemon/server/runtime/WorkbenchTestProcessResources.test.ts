/* No exports. Protect exact detached-service retirement and parent-owned cleanup. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import test from "node:test";
import WorkbenchTestProcessResources from "./WorkbenchTestProcessResources";

test("a retained service record kills its detached process without its spawning worker", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-service-retirement-");
  const directory = temporary.path;
  const record = path.join(directory, "service.json");
  const child = spawn(process.execPath, ["-e",
    'process.on("message", () => {}); process.send("ready");'], {
    detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = once(child, "exit");
  try {
    await once(child, "message");
    assert.ok(child.pid);
    await fs.writeFile(record, JSON.stringify({ pid: child.pid, password: "must-not-be-logged" }));
    await WorkbenchTestProcessResources.retireService(record);
    await exited;
    await assert.rejects(fs.stat(record), { code: "ENOENT" });
    await WorkbenchTestProcessResources.retireService(record);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await temporary.dispose();
  }
});

test("failed retirement preserves the ownership record and never counts as clean", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-service-retirement-");
  const directory = temporary.path;
  const record = path.join(directory, "service.json");
  try {
    await fs.writeFile(record, JSON.stringify({ pid: 12345 }));
    const killed: number[] = [];
    await assert.rejects(WorkbenchTestProcessResources.retireService(record, async pid => {
      killed.push(pid);
      throw new Error("access denied");
    }), /access denied/u);
    assert.deepEqual(killed, [12345]);
    assert.ok(await fs.stat(record));
  } finally { await temporary.dispose(); }
});

test("parent cleanup removes only registered project-owned scenario roots", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-scenario-retirement-");
  context.after(async () => await temporary.dispose());
  const source = temporary.path;
  const fixtures = path.join(source, ".workbench", "test-runs");
  const owned = path.join(fixtures, "wb-scenario-owned");
  const unrelated = path.join(fixtures, "other");
  await fs.mkdir(owned, { recursive: true });
  await fs.mkdir(unrelated);
  const resources = await WorkbenchTestProcessResources.create(false, source);
  const previous = process.env.WORKBENCH_TEST_SERVICE_RECORDS;
  process.env.WORKBENCH_TEST_SERVICE_RECORDS = resources.file;
  context.after(() => {
    if (previous === undefined) delete process.env.WORKBENCH_TEST_SERVICE_RECORDS;
    else process.env.WORKBENCH_TEST_SERVICE_RECORDS = previous;
  });
  await assert.rejects(
    WorkbenchTestProcessResources.trackWorkspace(source, unrelated),
    /scenario workspace/u,
  );
  await WorkbenchTestProcessResources.trackWorkspace(source, owned);
  await resources.dispose();
  await assert.rejects(fs.stat(owned), { code: "ENOENT" });
  assert.ok(await fs.stat(unrelated));
});

test("parent cleanup retains a killed scenario's logs, never its secrets", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-scenario-retirement-");
  context.after(async () => await temporary.dispose());
  const source = temporary.path;
  const fixtures = path.join(source, ".workbench", "test-runs");
  const owned = path.join(fixtures, "wb-scenario-killed");
  await fs.mkdir(path.join(owned, "codex"), { recursive: true });
  await fs.writeFile(path.join(owned, "scenario.log"), "waiting for app listener");
  await fs.writeFile(path.join(owned, "app.log"), "esbuild");
  await fs.writeFile(path.join(owned, "codex", "auth.json"), "secret");
  const reports: string[] = [];
  const resources = await WorkbenchTestProcessResources.create(false, source, message => reports.push(message));
  const previous = process.env.WORKBENCH_TEST_SERVICE_RECORDS;
  process.env.WORKBENCH_TEST_SERVICE_RECORDS = resources.file;
  context.after(() => {
    if (previous === undefined) delete process.env.WORKBENCH_TEST_SERVICE_RECORDS;
    else process.env.WORKBENCH_TEST_SERVICE_RECORDS = previous;
  });
  await WorkbenchTestProcessResources.trackWorkspace(source, owned);
  await resources.dispose();

  await assert.rejects(fs.stat(owned), { code: "ENOENT" });
  const retained = (await fs.readdir(fixtures)).filter(name => name.startsWith("failure-wb-scenario-killed-"));
  assert.equal(retained.length, 1);
  assert.deepEqual((await fs.readdir(path.join(fixtures, retained[0]!))).sort(), ["app.log", "scenario.log"]);
  assert.equal(await fs.readFile(path.join(fixtures, retained[0]!, "scenario.log"), "utf8"), "waiting for app listener");
  assert.deepEqual(reports, [`Scenario diagnostics retained: ${path.join(fixtures, retained[0]!)}`]);
});

test("retained scenario diagnostics keep only the newest runs and nothing else they do not own", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-scenario-retention-");
  context.after(async () => await temporary.dispose());
  const fixtures = path.join(temporary.path, ".workbench", "test-runs");
  const old = Date.now() - 60_000;
  const previous = Array.from({ length: 25 }, (_, index) => `failure-wb-scenario-old${String(index).padStart(2, "0")}-x`);
  for (const [index, name] of previous.entries()) {
    await fs.mkdir(path.join(fixtures, name), { recursive: true });
    const at = new Date(old + index * 1_000);
    await fs.utimes(path.join(fixtures, name), at, at);
  }
  await fs.mkdir(path.join(fixtures, "failure-unrelated"));
  const root = path.join(fixtures, "wb-scenario-current");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "scenario.log"), "now");

  const retained = await WorkbenchTestProcessResources.retainScenarioDiagnostics(root);
  const remaining = (await fs.readdir(fixtures)).filter(name => name.startsWith("failure-wb-scenario-")).sort();
  assert.equal(remaining.length, 20);
  assert.ok(remaining.includes(path.basename(retained)));
  assert.deepEqual(remaining.filter(name => name.includes("-old")), previous.slice(-19));
  assert.ok(await fs.stat(path.join(fixtures, "failure-unrelated")));
  assert.ok(await fs.stat(root), "retention never removes the scenario it copies from");
});
