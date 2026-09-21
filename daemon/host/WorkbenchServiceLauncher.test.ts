/*
 * No production exports. Tests coalesced service readiness and OS-observed startup failure.
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
