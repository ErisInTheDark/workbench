/*
 * No production exports. Tests coalesced service readiness, OS-observed startup failure and startup diagnostics.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import WorkbenchServiceLauncher from "./WorkbenchServiceLauncher.ts";
import type { WorkbenchServiceEndpoint } from "../../shared/http/workbench-service.ts";

test("concurrent app requests share startup and wait for verified readiness", async context => {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let endpoint: WorkbenchServiceEndpoint | null = null;
  let starts = 0;
  let verified = 0;
  const launcher = new WorkbenchServiceLauncher({
    root: "/checkout", endpointPath: "unused",
    read: async () => endpoint,
    verify: async () => { verified++; },
    acquire: async () => ({ dispose: async () => {} }),
    startup: {
      start: async () => {
        starts++;
        start();
        await released;
        endpoint = { version: 1, instanceId: randomUUID(), pid: 1, origin: "http://127.0.0.1:1234", token: "a".repeat(64) };
        return "before";
      },
      status: async () => ({ generation: "after", phase: "running", result: "0" }),
    },
    warn: () => {},
  });
  context.after(async () => { release(); await launcher.close(); });
  const first = launcher.ensure();
  const second = launcher.ensure();
  await started;
  assert.equal(starts, 1);
  assert.equal(verified, 0);
  release();
  const endpoints = await Promise.all([first, second]);
  assert.equal(endpoints[0].instanceId, endpoints[1].instanceId);
  assert.equal(verified, 1);
});

test("an OS-observed failed run rejects instead of waiting forever for publication", async context => {
  const launcher = new WorkbenchServiceLauncher({
    root: "/checkout", endpointPath: "unused",
    read: async () => null,
    acquire: async () => ({ dispose: async () => {} }),
    startup: {
      start: async () => "before",
      status: async () => ({ generation: "after", phase: "stopped", result: "native failure" }),
    },
    warn: () => {},
  });
  context.after(() => launcher.close());
  await assert.rejects(launcher.ensure(), /native failure/);
});

test("a host that restarts before publication logs each observed run", async context => {
  const runs = [
    { generation: "a", phase: "starting", result: "success" },
    { generation: "a", phase: "starting", result: "success" },
    { generation: "b", phase: "starting", result: "exit-code" },
    { generation: "c", phase: "stopped", result: "exit-code" },
  ] as const;
  let polls = 0;
  const lines: string[] = [];
  const launcher = new WorkbenchServiceLauncher({
    root: "/checkout", endpointPath: "unused",
    read: async () => null,
    acquire: async () => ({ dispose: async () => {} }),
    waitForChange: async () => {},
    startup: { start: async () => "before", status: async () => runs[Math.min(polls++, runs.length - 1)]! },
    warn: () => {},
    log: message => lines.push(message),
  });
  context.after(() => launcher.close());
  await assert.rejects(launcher.ensure(), /stopped before readiness: exit-code/u);
  const observed = lines.filter(line => line.includes("(run "));
  assert.deepEqual(observed.map(line => line.match(/\(run (\w+)/u)?.[1]), ["a", "b", "c"]);
});

for (const failure of ["start", "stopped"] as const) {
  test(`a ${failure} failure reports platform output and keeps the original rejection`, async context => {
    const warnings: string[] = [];
    const launcher = new WorkbenchServiceLauncher({
      root: "/checkout", endpointPath: "unused",
      read: async () => null,
      acquire: async () => ({ dispose: async () => {} }),
      startup: {
        start: async () => { if (failure === "start") throw new Error("systemctl failed (1): bad unit file setting"); return "before"; },
        status: async () => ({ generation: "after", phase: "stopped", result: "exit-code" }),
        recentOutput: async () => "WorkingDirectory= path is not absolute\nUnit configuration has fatal error",
      },
      warn: message => warnings.push(message),
    });
    context.after(() => launcher.close());
    await assert.rejects(launcher.ensure(), failure === "start" ? /bad unit file setting/u : /stopped before readiness/u);
    assert.match(warnings.join("\n"), /WorkingDirectory= path is not absolute/u);
    assert.match(warnings.join("\n"), /fatal error/u);
  });
}

test("unavailable platform output is reported without replacing the startup failure", async context => {
  const warnings: string[] = [];
  const launcher = new WorkbenchServiceLauncher({
    root: "/checkout", endpointPath: "unused",
    read: async () => null,
    acquire: async () => ({ dispose: async () => {} }),
    startup: {
      start: async () => { throw new Error("systemctl failed (1): bad unit file setting"); },
      status: async () => ({ generation: "after", phase: "stopped", result: "exit-code" }),
      recentOutput: async () => { throw new Error("journalctl missing"); },
    },
    warn: message => warnings.push(message),
  });
  context.after(() => launcher.close());
  await assert.rejects(launcher.ensure(), /bad unit file setting/u);
  assert.match(warnings.join("\n"), /recent host output unavailable: journalctl missing/u);
});

test("closing during a failing readiness probe warns instead of failing shutdown", async context => {
  let releaseStatus!: (error: Error) => void;
  let statusStarted!: () => void;
  const started = new Promise<void>(resolve => { statusStarted = resolve; });
  const warnings: string[] = [];
  const launcher = new WorkbenchServiceLauncher({
    root: "/checkout", endpointPath: "unused",
    read: async () => null,
    acquire: async () => ({ dispose: async () => {} }),
    startup: {
      start: async () => "before",
      status: () => new Promise((_resolve, reject) => { releaseStatus = reject; statusStarted(); }),
    },
    warn: message => warnings.push(message),
  });
  context.after(() => launcher.close());
  const ensure = launcher.ensure();
  void ensure.catch(() => {});
  await started;
  const closed = launcher.close();
  releaseStatus(new Error("powershell.exe failed (1): Access denied"));
  await closed;
  await assert.rejects(ensure, /Access denied/);
  assert.match(warnings.join("\n"), /Access denied/u);
});
