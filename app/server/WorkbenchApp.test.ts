/*
 * No production exports. Node tests protect thread fencing, singleton startup, failure cleanup, and ordered app disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchApp, {
  type WorkbenchAppLease,
  type WorkbenchAppPortControl,
  type WorkbenchAppRuntime,
  type WorkbenchAppServer,
} from "./WorkbenchApp.ts";

const address = {
  hostname: "127.0.0.1",
  port: 43_210,
  url: "http://127.0.0.1:43210",
};

test("closing during runtime startup reaches the owner and prevents listener publication", async () => {
  let enter!: () => void;
  let release!: () => void;
  let runtimeClosed = false;
  let leaseClosed = false;
  let listenerCreated = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const app = new WorkbenchApp({
    callerThreadId: null,
    acquireLaunchLease: async () => ({ dispose: async () => { leaseClosed = true; } }),
    createRuntime: () => ({
      start: async () => { enter(); await pending; },
      close: async () => { runtimeClosed = true; release(); },
      handleRequest: async () => {}, readAppPort: () => null, writeAppPort: async () => {},
    }),
    createServer: () => {
      listenerCreated = true;
      return { start: async () => address, close: async () => {}, moveToPort: async () => address };
    },
  });
  const starting = app.start().then(() => null, error => error);
  await entered;
  const closing = app.close();
  try {
    await Promise.resolve();
    assert.equal(runtimeClosed, true, "Startup resources must already belong to the application");
    assert.ok(await starting instanceof Error);
    await closing;
    assert.equal(leaseClosed, true);
    assert.equal(listenerCreated, false);
  } finally { release(); await starting; await closing; }
});

test("a lease acquired after close begins is released without constructing a runtime", async () => {
  let deliver!: (lease: WorkbenchAppLease) => void;
  let released = false;
  const lease = new Promise<WorkbenchAppLease>(resolve => { deliver = resolve; });
  const app = new WorkbenchApp({
    callerThreadId: null,
    acquireLaunchLease: () => lease,
    createRuntime: () => { throw new Error("A closing app must not create a runtime"); },
    createServer: () => { throw new Error("A closing app must not create a listener"); },
  });
  const starting = app.start().then(() => null, error => error);
  const closing = app.close();
  deliver({ dispose: async () => { released = true; } });
  assert.ok(await starting instanceof Error);
  await closing;
  assert.equal(released, true, "Late-acquired resources cannot escape closure");
});

function fixture(options: {
  environmentPort?: number | null;
  failMove?: boolean;
  failLeaseDispose?: boolean;
  failServerClose?: boolean;
  failServerStart?: boolean;
  failRuntimeClose?: boolean;
  failRuntimeStart?: boolean;
  failWritePort?: boolean;
  firstMoveGate?: Promise<void>;
  leaseAvailable?: boolean;
  savedPort?: number | null;
} = {}) {
  const events: string[] = [];
  const addressChanges: typeof address[] = [];
  let appPortControl: WorkbenchAppPortControl | null = null;
  let createdPort: number | null = null;
  let moveCount = 0;
  let savedPort = options.savedPort ?? null;
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
    moveToPort: async (port, beforeActivate) => {
      moveCount += 1;
      events.push(`server:bind:${port}`);
      if (options.failMove) {
        const error = new Error("port unavailable") as NodeJS.ErrnoException;
        error.code = "EADDRINUSE";
        throw error;
      }
      if (moveCount === 1) await options.firstMoveGate;
      await beforeActivate();
      events.push(`server:activate:${port}`);
      return { hostname: "127.0.0.1", port, url: `http://127.0.0.1:${port}` };
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
    readAppPort: () => savedPort,
    start: async () => {
      events.push("runtime:start");
      if (options.failRuntimeStart) throw new Error("runtime start failed");
    },
    writeAppPort: async (port) => {
      events.push(`runtime:write-port:${port}`);
      if (options.failWritePort) throw new Error("port persistence failed");
      savedPort = port;
    },
  };
  let serverCreations = 0;
  const app = new WorkbenchApp({
    acquireLaunchLease: async () => {
      events.push("lease:acquire");
      return options.leaseAvailable === false ? null : lease;
    },
    callerThreadId: null,
    createRuntime: (control) => {
      appPortControl = control;
      return runtime;
    },
    createServer: (_runtime, port) => {
      serverCreations += 1;
      createdPort = port;
      return server;
    },
    environmentPort: options.environmentPort,
    onAddressChange: (nextAddress) => addressChanges.push(nextAddress),
  });
  return {
    addressChanges,
    app,
    events,
    get appPortControl() {
      if (!appPortControl) throw new Error("app port control is unavailable");
      return appPortControl;
    },
    get createdPort() { return createdPort; },
    get savedPort() { return savedPort; },
    get serverCreations() { return serverCreations; },
  };
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
  assert.deepEqual(await target.app.start(), { address, kind: "started", portSource: "random" });
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

test("runtime startup failure releases the lease without constructing a listener", async () => {
  const target = fixture({ failRuntimeStart: true });
  await assert.rejects(target.app.start(), /runtime start failed/u);
  assert.equal(target.serverCreations, 0);
  assert.deepEqual(target.events, [
    "lease:acquire",
    "runtime:start",
    "runtime:close",
    "lease:dispose",
  ]);
});

test("startup prefers the environment, then saved state, then a random port", async () => {
  const environment = fixture({ environmentPort: 44_001, savedPort: 44_002 });
  const environmentResult = await environment.app.start();
  assert.equal(environment.createdPort, 44_001);
  assert.equal(environmentResult.kind === "started" ? environmentResult.portSource : null, "environment");
  assert.deepEqual(environment.appPortControl.read(), {
    appOrigin: address.url,
    currentPort: address.port,
    editable: false,
    source: "environment",
  });

  const saved = fixture({ savedPort: 44_002 });
  const savedResult = await saved.app.start();
  assert.equal(saved.createdPort, 44_002);
  assert.equal(savedResult.kind === "started" ? savedResult.portSource : null, "setting");
  assert.equal(saved.appPortControl.read().source, "setting");

  const random = fixture();
  const randomResult = await random.app.start();
  assert.equal(random.createdPort, 0);
  assert.equal(randomResult.kind === "started" ? randomResult.portSource : null, "random");
  assert.equal(random.appPortControl.read().source, "random");
});

test("moves the listener only after persistence and publishes the new origin", async () => {
  const target = fixture();
  await target.app.start();
  const snapshot = await target.appPortControl.update(44_003);
  assert.deepEqual(target.events.slice(-3), [
    "server:bind:44003",
    "runtime:write-port:44003",
    "server:activate:44003",
  ]);
  assert.equal(target.savedPort, 44_003);
  assert.deepEqual(snapshot, {
    appOrigin: "http://127.0.0.1:44003",
    currentPort: 44_003,
    editable: true,
    source: "setting",
  });
  assert.deepEqual(target.addressChanges, [{
    hostname: "127.0.0.1",
    port: 44_003,
    url: "http://127.0.0.1:44003",
  }]);
});

test("listener subscriptions observe readiness and committed moves without guessing startup ports", async () => {
  const observed: (number | null)[] = [];
  let control!: WorkbenchAppPortControl;
  let unsubscribe!: () => void;
  const app = new WorkbenchApp({
    callerThreadId: null,
    acquireLaunchLease: async () => ({ dispose: async () => {} }),
    createRuntime: value => {
      control = value;
      return {
        start: async () => {
          assert.ok(control.current);
          assert.ok(control.subscribe);
          observed.push(control.current()?.currentPort ?? null);
          unsubscribe = control.subscribe(async () => { observed.push(control.current?.()?.currentPort ?? null); });
        },
        close: async () => { unsubscribe?.(); },
        handleRequest: async () => {}, readAppPort: () => null, writeAppPort: async () => {},
      };
    },
    createServer: () => ({
      start: async () => address, close: async () => {},
      moveToPort: async (port, save) => {
        if (port === 44002) throw new Error("bind failed");
        await save();
        return { ...address, port, url: `http://127.0.0.1:${port}` };
      },
    }),
  });
  try {
    await app.start();
    await control.update(44001);
    await assert.rejects(control.update(44002));
    assert.deepEqual(observed, [null, address.port, 44001]);
    unsubscribe();
    await control.update(44003);
    assert.deepEqual(observed, [null, address.port, 44001]);
  } finally { await app.close(); }
});

test("shutdown cancels network forwarding before waiting for an in-flight port notification", async () => {
  let control!: WorkbenchAppPortControl;
  let release!: () => void;
  let entered!: () => void;
  let stopped = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const notifying = new Promise<void>(resolve => { entered = resolve; });
  const app = new WorkbenchApp({
    callerThreadId: null,
    acquireLaunchLease: async () => ({ dispose: async () => {} }),
    createRuntime: value => {
      control = value;
      return {
        start: async () => { control.subscribe?.(async () => {
          if (control.read().currentPort !== 44001) return;
          entered();
          await blocked;
        }); },
        stopNetwork: async () => { stopped = true; release(); },
        close: async () => {},
        handleRequest: async () => {}, readAppPort: () => null, writeAppPort: async () => {},
      };
    },
    createServer: () => ({
      start: async () => address, close: async () => {},
      moveToPort: async (port, save) => { await save(); return { ...address, port, url: `http://127.0.0.1:${port}` }; },
    }),
  });
  await app.start();
  const moving = control.update(44001);
  await notifying;
  const closing = app.close();
  try { assert.equal(stopped, true); }
  finally { release(); await moving; await closing; }
});

test("failed bind or persistence leaves the current listener truth unchanged", async () => {
  const bindFailure = fixture({ failMove: true });
  await bindFailure.app.start();
  await assert.rejects(bindFailure.appPortControl.update(44_004), /port unavailable/u);
  assert.equal(bindFailure.savedPort, null);
  assert.deepEqual(bindFailure.appPortControl.read(), {
    appOrigin: address.url,
    currentPort: address.port,
    editable: true,
    source: "random",
  });

  const persistenceFailure = fixture({ failWritePort: true });
  await persistenceFailure.app.start();
  await assert.rejects(persistenceFailure.appPortControl.update(44_005), /persistence failed/u);
  assert.equal(persistenceFailure.savedPort, null);
  assert.deepEqual(persistenceFailure.appPortControl.read(), {
    appOrigin: address.url,
    currentPort: address.port,
    editable: true,
    source: "random",
  });
});

test("serializes concurrent port moves and rejects edits owned by the environment", async () => {
  let releaseFirstMove = () => {};
  const firstMoveGate = new Promise<void>((resolve) => {
    releaseFirstMove = resolve;
  });
  const target = fixture({ firstMoveGate });
  await target.app.start();
  const first = target.appPortControl.update(44_006);
  const second = target.appPortControl.update(44_007);
  await Promise.resolve();
  assert.deepEqual(target.events.slice(-1), ["server:bind:44006"]);
  releaseFirstMove();
  await Promise.all([first, second]);
  assert.deepEqual(target.events.slice(-6), [
    "server:bind:44006",
    "runtime:write-port:44006",
    "server:activate:44006",
    "server:bind:44007",
    "runtime:write-port:44007",
    "server:activate:44007",
  ]);

  const environment = fixture({ environmentPort: 44_008 });
  await environment.app.start();
  await assert.rejects(
    environment.appPortControl.update(44_009),
    /controlled by WORKBENCH_APP_PORT/u,
  );
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
