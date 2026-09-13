/* No production exports. Tests protect external-server preservation, managed-server ownership, restart, environment restoration, and failure suppression. */
import assert from "node:assert/strict";
import { test } from "node:test";

import OpenCodeAppServer, { type OpenCodeAppServerOptions } from "./OpenCodeAppServer";

function configResult() {
  return {
    baseConfigDirectory: "C:/base",
    baseConfigMetadata: null,
    configDirectory: "C:/overlay",
    copiedBaseConfig: false,
    unavailableBaseConfigReason: "missing",
  };
}

function options(overrides: Partial<OpenCodeAppServerOptions> = {}): OpenCodeAppServerOptions {
  return {
    ensureConfig: async () => configResult(),
    environment: { NODE_ENV: "test" },
    getReloadableModules: () => { throw new Error("unexpected reloadable-module read"); },
    log: () => undefined,
    logError: () => undefined,
    ...overrides,
  };
}

test("replacement waits for predecessor retirement before launching and shutdown cancels that launch", async () => {
  let release!: () => void;
  const retirement = new Promise<void>(resolve => { release = resolve; });
  const previous = new OpenCodeAppServer(options({
    createServer: () => ({ start: async () => "http://127.0.0.1:4096", close: () => retirement }),
  }));
  await previous.getBaseUrl();
  let created = false;
  const replacement = new OpenCodeAppServer(options({
    previousAppServer: previous,
    createServer: () => {
      created = true;
      return { start: async () => "http://127.0.0.1:4096", close: async () => {} };
    },
  }));
  const startup = replacement.getBaseUrl();
  const rejected = assert.rejects(startup, /retired/u);
  try {
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(created, false, "A replacement must not race the old listener");
  } finally {
    const shutdown = replacement.stop();
    release();
    await shutdown;
    await rejected;
  }
  assert.equal(created, false, "Shutdown must prevent late predecessor completion from launching");
});

test("managed stop waits for owned process retirement and propagates failure", async () => {
  let release!: () => void;
  const retirement = new Promise<void>(resolve => { release = resolve; });
  const server = new OpenCodeAppServer(options({
    createServer: () => ({ start: async () => "http://127.0.0.1:4096", close: () => retirement }),
  }));
  await server.getBaseUrl();
  let stopped = false;
  const stopping = server.stop().then(() => { stopped = true; });
  try {
    await Promise.resolve();
    assert.equal(stopped, false, "The owner cannot declare closure while its child still retires");
  } finally { release(); await stopping; }

  const failure = new Error("owned process termination denied");
  const failed = Promise.reject(failure);
  void failed.catch(() => {});
  const broken = new OpenCodeAppServer(options({
    createServer: () => ({ start: async () => "http://127.0.0.1:4096", close: () => failed }),
  }));
  await broken.getBaseUrl();
  await assert.rejects(broken.stop(), error => error === failure);
});

test("external OpenCode selection is normalized and never closed by restart or stop", async () => {
  let createCount = 0;
  const server = new OpenCodeAppServer(options({
    createServer: () => { createCount += 1; throw new Error("unexpected managed startup"); },
    environment: { NODE_ENV: "test", OPENCODE_SERVER_URL: "http://127.0.0.1:4096/path?query=yes" },
  }));
  assert.equal(await server.getBaseUrl(), "http://127.0.0.1:4096");
  await server.restart();
  await server.stop();
  assert.equal(createCount, 0);
});

test("managed server startup is coalesced, restores config environment, and restart closes only the owned handle", async () => {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", OPENCODE_CONFIG_DIR: "C:/original" };
  const closed: number[] = [];
  let createCount = 0;
  const server = new OpenCodeAppServer(options({
    createServer: () => {
      createCount += 1;
      assert.equal(environment.OPENCODE_CONFIG_DIR, "C:/overlay");
      const id = createCount;
      return { close: async () => { closed.push(id); }, start: async () => `http://127.0.0.1:${4096 + id}/nested` };
    },
    environment,
  }));
  assert.deepEqual(await Promise.all([server.getBaseUrl(), server.getBaseUrl()]), ["http://127.0.0.1:4097", "http://127.0.0.1:4097"]);
  assert.equal(createCount, 1);
  assert.equal(environment.OPENCODE_CONFIG_DIR, "C:/original");
  await server.restart();
  assert.deepEqual(closed, [1]);
  assert.equal(await server.getBaseUrl(), "http://127.0.0.1:4098");
  await server.stop();
  assert.deepEqual(closed, [1, 2]);
});

test("transient startup failure cools down while missing executable failure disables managed startup", async () => {
  let now = 1_000;
  let transientAttempts = 0;
  const transient = new OpenCodeAppServer(options({
    createServer: () => { transientAttempts += 1; throw new Error("port unavailable"); },
    now: () => now,
    retryCooldownMs: 100,
  }));
  await assert.rejects(transient.getBaseUrl(), /port unavailable/u);
  await assert.rejects(transient.getBaseUrl(), /Retry suppressed/u);
  assert.equal(transientAttempts, 1);
  now += 101;
  await assert.rejects(transient.getBaseUrl(), /port unavailable/u);
  assert.equal(transientAttempts, 2);

  let missingAttempts = 0;
  const missing = new OpenCodeAppServer(options({
    createServer: () => { missingAttempts += 1; throw new Error("spawn opencode ENOENT"); },
  }));
  await assert.rejects(missing.getBaseUrl(), /could not find the OpenCode executable/u);
  assert.equal(missing.isDisabled(), true);
  await assert.rejects(missing.getBaseUrl(), /stay disabled/u);
  assert.equal(missingAttempts, 1);
  await missing.restart();
  assert.equal(missing.isDisabled(), false);
});

test("stop owns the process before readiness and late readiness cannot replace the next server", async () => {
  let entered!: () => void;
  const starting = new Promise<void>((resolve) => { entered = resolve; });
  let deliver!: (url: string) => void;
  let retiredClosed!: () => void;
  const closed = new Promise<void>((resolve) => { retiredClosed = resolve; });
  let oldSignal: AbortSignal | undefined;
  let calls = 0;
  const server = new OpenCodeAppServer(options({
    createServer: (settings) => {
      if (++calls > 1) return { start: async () => "http://127.0.0.1:4098", close: async () => {} };
      oldSignal = settings?.signal;
      return {
        start: () => { entered(); return new Promise((resolve) => { deliver = resolve; }); },
        close: async () => { retiredClosed(); },
      };
    },
  }));
  const oldStart = server.getBaseUrl();
  const rejected = assert.rejects(oldStart, /retired/u);
  await starting;
  const stopped = server.stop();
  assert.equal(oldSignal?.aborted, true);
  await stopped;
  await rejected;
  assert.equal(await server.getBaseUrl(), "http://127.0.0.1:4098");
  deliver("http://127.0.0.1:4097");
  await closed;
  assert.equal(await server.getBaseUrl(), "http://127.0.0.1:4098");
  await server.stop();
});
