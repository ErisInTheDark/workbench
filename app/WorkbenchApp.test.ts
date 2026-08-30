/*
 * No production exports. Node tests protect thread fencing, singleton startup, failure cleanup, and ordered app disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchApp, {
  type WorkbenchAppLease,
  type WorkbenchAppRuntime,
  type WorkbenchAppServer,
} from "./WorkbenchApp.ts";

const address = {
  hostname: "127.0.0.1",
  port: 43_210,
  url: "http://127.0.0.1:43210",
};

function fixture(options: {
  failLeaseDispose?: boolean;
  failServerClose?: boolean;
  failServerStart?: boolean;
  failRuntimeClose?: boolean;
  failRuntimeStart?: boolean;
  leaseAvailable?: boolean;
} = {}) {
  const events: string[] = [];
  const lease: WorkbenchAppLease = {
    dispose: async () => {
      events.push("lease:dispose");
      if (options.failLeaseDispose) throw new Error("lease dispose failed");
    },
  };
  const server: WorkbenchAppServer = {
    close: async () => {
      events.push("server:close");
      if (options.failServerClose) throw new Error("server close failed");
    },
    start: async () => {
      events.push("server:start");
      if (options.failServerStart) throw new Error("server start failed");
      return address;
    },
  };
  const runtime: WorkbenchAppRuntime = {
    close: async () => {
      events.push("runtime:close");
      if (options.failRuntimeClose) throw new Error("runtime close failed");
    },
    handleRequest: async () => {},
    start: async () => {
      events.push("runtime:start");
      if (options.failRuntimeStart) throw new Error("runtime start failed");
    },
  };
  let serverCreations = 0;
  const app = new WorkbenchApp({
    acquireLaunchLease: async () => {
      events.push("lease:acquire");
      return options.leaseAvailable === false ? null : lease;
    },
    callerThreadId: null,
    createRuntime: () => runtime,
    createServer: () => {
      serverCreations += 1;
      return server;
    },
  });
  return { app, events, get serverCreations() { return serverCreations; } };
}

test("does not construct a server when another app owns the launch lease", async () => {
  const target = fixture({ leaseAvailable: false });
  assert.deepEqual(await target.app.start(), { kind: "already-running" });
  assert.equal(target.serverCreations, 0);
  assert.deepEqual(target.events, ["lease:acquire"]);
});

test("rejects a managed thread before acquiring app resources", async () => {
  let acquired = false;
  const app = new WorkbenchApp({
    acquireLaunchLease: async () => {
      acquired = true;
      return null;
    },
    callerThreadId: "thread-one",
    createRuntime: () => { throw new Error("runtime must not be constructed"); },
    createServer: () => {
      throw new Error("server must not be constructed");
    },
  });
  await assert.rejects(app.start(), /Managed agent threads/u);
  assert.equal(acquired, false);
});

test("closes the server before releasing the app lease", async () => {
  const target = fixture();
  assert.deepEqual(await target.app.start(), { address, kind: "started" });
  await target.app.close();
  assert.deepEqual(target.events, [
    "lease:acquire",
    "runtime:start",
    "server:start",
    "server:close",
    "runtime:close",
    "lease:dispose",
  ]);
});

test("releases the lease after startup failure", async () => {
  const target = fixture({ failServerStart: true });
  await assert.rejects(target.app.start(), /start failed/u);
  assert.deepEqual(target.events, [
    "lease:acquire",
    "runtime:start",
    "server:start",
    "server:close",
    "runtime:close",
    "lease:dispose",
  ]);
});

test("shutdown attempts every reverse-order owner and aggregates failures", async () => {
  const target = fixture({ failLeaseDispose: true, failRuntimeClose: true, failServerClose: true });
  await target.app.start();
  await assert.rejects(target.app.close(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((failure) => failure instanceof Error ? failure.message : String(failure)), [
      "server close failed",
      "runtime close failed",
      "lease dispose failed",
    ]);
    return true;
  });
  assert.deepEqual(target.events, [
    "lease:acquire",
    "runtime:start",
    "server:start",
    "server:close",
    "runtime:close",
    "lease:dispose",
  ]);
});
