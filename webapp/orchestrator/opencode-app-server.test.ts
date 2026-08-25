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

test("external OpenCode selection is normalized and never closed by restart or stop", async () => {
  let createCount = 0;
  const server = new OpenCodeAppServer(options({
    createServer: (async () => { createCount += 1; throw new Error("unexpected managed startup"); }) as NonNullable<OpenCodeAppServerOptions["createServer"]>,
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
    createServer: (async () => {
      createCount += 1;
      assert.equal(environment.OPENCODE_CONFIG_DIR, "C:/overlay");
      const id = createCount;
      return { close: () => { closed.push(id); }, url: `http://127.0.0.1:${4096 + id}/nested` };
    }) as NonNullable<OpenCodeAppServerOptions["createServer"]>,
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
    createServer: (async () => { transientAttempts += 1; throw new Error("port unavailable"); }) as NonNullable<OpenCodeAppServerOptions["createServer"]>,
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
    createServer: (async () => { missingAttempts += 1; throw new Error("spawn opencode ENOENT"); }) as NonNullable<OpenCodeAppServerOptions["createServer"]>,
  }));
  await assert.rejects(missing.getBaseUrl(), /could not find the OpenCode executable/u);
  assert.equal(missing.isDisabled(), true);
  await assert.rejects(missing.getBaseUrl(), /stay disabled/u);
  assert.equal(missingAttempts, 1);
  await missing.restart();
  assert.equal(missing.isDisabled(), false);
});
