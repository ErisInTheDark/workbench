/*
 * No production exports. Node tests protect thread fencing, singleton startup, failure cleanup, and ordered app disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchApp, {
  type WorkbenchAppLease,
  type WorkbenchAppServer,
} from "./WorkbenchApp.ts";

const address = {
  hostname: "127.0.0.1",
  port: 43_210,
  url: "http://127.0.0.1:43210",
};

function fixture(options: { failClose?: boolean; failStart?: boolean; leaseAvailable?: boolean } = {}) {
  const events: string[] = [];
  const lease: WorkbenchAppLease = {
    dispose: async () => {
      events.push("lease:dispose");
    },
  };
  const server: WorkbenchAppServer = {
    close: async () => {
      events.push("server:close");
      if (options.failClose) throw new Error("close failed");
    },
    start: async () => {
      events.push("server:start");
      if (options.failStart) throw new Error("start failed");
      return address;
    },
  };
  let serverCreations = 0;
  const app = new WorkbenchApp({
    acquireLaunchLease: async () => {
      events.push("lease:acquire");
      return options.leaseAvailable === false ? null : lease;
    },
    callerThreadId: null,
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
    "server:start",
    "server:close",
    "lease:dispose",
  ]);
});

test("releases the lease after startup failure", async () => {
  const target = fixture({ failStart: true });
  await assert.rejects(target.app.start(), /start failed/u);
  assert.deepEqual(target.events, [
    "lease:acquire",
    "server:start",
    "server:close",
    "lease:dispose",
  ]);
});

test("retains the lease when owned server shutdown fails", async () => {
  const target = fixture({ failClose: true });
  await target.app.start();
  await assert.rejects(target.app.close(), /close failed/u);
  assert.deepEqual(target.events, [
    "lease:acquire",
    "server:start",
    "server:close",
  ]);
});
