/*
 * Exports:
 * - tests: protect dedicated service ownership, companion injection, capability verification, and client coalescing.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { EnsureOptions } from "@opencode/client/service";
import OpenCodeServiceController from "./OpenCodeServiceController";

test("coalesces acquisition through the dedicated Workbench OpenCode service", async () => {
  let ensures = 0;
  let creates = 0;
  let stops = 0;
  let ensureOptions: EnsureOptions | undefined;
  const client = {
    plugin: {
      list: async () => ({ data: [{ id: "workbench", state: { status: "active" } }] }),
    },
  };
  const endpoint = { url: "http://127.0.0.1:4096" };
  const dataRoot = path.resolve("workbench-opencode-service-test");
  const controller = new OpenCodeServiceController({
    environment: {
      WORKBENCH_DATA_ROOT: dataRoot,
      XDG_DATA_HOME: "user-data",
      XDG_CONFIG_HOME: "user-config",
    },
    prepareServiceDirectory: async () => undefined,
    ensureService: async options => {
      ensures++;
      ensureOptions = options;
      await Promise.resolve();
      return endpoint;
    },
    createClient: value => {
      creates++;
      assert.equal(value, endpoint);
      return client as never;
    },
    stopService: async options => {
      stops++;
      assert.deepEqual(options, {
        file: path.join(dataRoot, "daemon", "providers", "opencode", "state", "opencode", "service.json"),
        pty: "handoff",
      });
    },
  });

  const [first, second] = await Promise.all([controller.acquire(), controller.acquire()]);
  assert.equal(first, client);
  assert.equal(second, client);
  assert.equal(ensures, 1);
  assert.equal(creates, 1);
  assert.deepEqual(ensureOptions?.command, ["opencode", "serve", "--service", "--port", "0"]);
  assert.equal(
    ensureOptions?.file,
    path.join(dataRoot, "daemon", "providers", "opencode", "state", "opencode", "service.json"),
  );
  assert.equal(
    ensureOptions?.env?.XDG_STATE_HOME,
    path.join(dataRoot, "daemon", "providers", "opencode", "state"),
  );
  assert.equal(ensureOptions?.env?.XDG_DATA_HOME, undefined);
  assert.equal(ensureOptions?.env?.XDG_CONFIG_HOME, undefined);
  const config = JSON.parse(ensureOptions?.env?.OPENCODE_CONFIG_CONTENT ?? "{}") as {
    $schema?: string;
    plugins?: string[];
  };
  assert.equal(config.$schema, "https://opencode.ai/config.json");
  assert.equal(config.plugins?.length, 1);
  const pluginSource = config.plugins?.[0] ?? "";
  assert.equal(path.isAbsolute(pluginSource), true);
  assert.equal(path.basename(pluginSource), "workbench-plugin");
  assert.equal(path.extname(pluginSource), "");
  assert.ok(ensureOptions?.env?.WORKBENCH_DATA_ROOT);
  assert.equal(typeof ensureOptions?.version, "function");
  if (typeof ensureOptions?.version === "function") {
    assert.equal(ensureOptions.version("2.0.9"), true);
    assert.equal(ensureOptions.version("3.0.0"), false);
  }

  await controller.dispose();
  await controller.dispose();
  assert.equal(stops, 1);
  await assert.rejects(controller.acquire(), /has been disposed/u);
});

test("allows failed dedicated-service acquisition to be retried", async () => {
  let attempts = 0;
  const client = {
    plugin: {
      list: async () => ({ data: [{ id: "workbench", state: { status: "active" } }] }),
    },
  };
  const controller = new OpenCodeServiceController({
    prepareServiceDirectory: async () => undefined,
    ensureService: async () => {
      if (++attempts === 1) throw new Error("service failed");
      return { url: "http://127.0.0.1:4096" };
    },
    createClient: () => client as never,
    stopService: async () => undefined,
  });

  await assert.rejects(controller.acquire(), /service failed/u);
  assert.equal(await controller.acquire(), client);
  assert.equal(attempts, 2);
  await controller.dispose();
});

test("stops a dedicated service that fails after its process starts", async () => {
  let stops = 0;
  const dataRoot = path.resolve("workbench-opencode-failed-start-test");
  const controller = new OpenCodeServiceController({
    environment: {
      WORKBENCH_DATA_ROOT: dataRoot,
    },
    prepareServiceDirectory: async () => undefined,
    ensureService: async options => {
      options?.onStart?.("missing");
      throw new Error("service readiness failed");
    },
    stopService: async options => {
      stops++;
      assert.deepEqual(options, {
        file: path.join(dataRoot, "daemon", "providers", "opencode", "state", "opencode", "service.json"),
        pty: "handoff",
      });
    },
  });

  await assert.rejects(controller.acquire(), /service readiness failed/u);
  assert.equal(stops, 1);
});

test("preserves existing inline OpenCode config while adding the companion", async () => {
  let ensureOptions: EnsureOptions | undefined;
  const controller = new OpenCodeServiceController({
    prepareServiceDirectory: async () => undefined,
    environment: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: "existing/model",
        plugins: ["file:///existing-plugin.ts"],
      }),
    },
    ensureService: async options => {
      ensureOptions = options;
      return { url: "http://127.0.0.1:4096" };
    },
    createClient: () => ({
      plugin: {
        list: async () => ({ data: [{ id: "workbench", state: { status: "active" } }] }),
      },
    } as never),
    stopService: async () => undefined,
  });

  await controller.acquire();
  const config = JSON.parse(ensureOptions?.env?.OPENCODE_CONFIG_CONTENT ?? "{}") as {
    model?: string;
    plugins?: string[];
  };
  assert.equal(config.model, "existing/model");
  assert.equal(config.plugins?.[0], "file:///existing-plugin.ts");
  assert.equal(path.basename(config.plugins?.[1] ?? ""), "workbench-plugin");
  await controller.dispose();
});

test("stops a dedicated service that did not load the Workbench companion", async () => {
  const controller = new OpenCodeServiceController({
    prepareServiceDirectory: async () => undefined,
    ensureService: async () => ({ url: "http://127.0.0.1:4096" }),
    createClient: () => ({
      plugin: {
        list: async () => ({
          data: [{
            id: "workbench",
            source: { type: "local", path: "plugin.ts" },
            features: {},
            state: { status: "failed", error: "load failed" },
          }],
        }),
      },
    } as never),
    stopService: async () => undefined,
  });

  await assert.rejects(controller.acquire(), /companion did not load/iu);
  await controller.dispose();
});

test("waits for configured companion readiness instead of sampling plugin state once", async () => {
  let reads = 0;
  const controller = new OpenCodeServiceController({
    pluginSource: "file:///workbench-plugin.ts",
    prepareServiceDirectory: async () => undefined,
    ensureService: async () => ({ url: "http://127.0.0.1:4096" }),
    createClient: () => ({
      config: {
        get: async () => [{
          type: "document",
          info: { plugins: ["file:///workbench-plugin.ts"] },
        }],
      },
      event: {
        subscribe: async function* () {
          yield { type: "plugin.updated" };
        },
      },
      plugin: {
        list: async () => ({
          data: ++reads < 3 ? [] : [{
            id: "workbench",
            source: { type: "local", path: "workbench-plugin.ts" },
            features: { server: true },
            state: { status: "active" },
          }],
        }),
      },
    } as never),
    stopService: async () => undefined,
  });

  await controller.acquire();
  assert.equal(reads, 3);
  await controller.dispose();
});

test("warns when companion configuration inspection fails but plugin readiness recovers", async () => {
  const warnings: string[] = [];
  let reads = 0;
  const controller = new OpenCodeServiceController({
    pluginSource: "file:///workbench-plugin.ts",
    prepareServiceDirectory: async () => undefined,
    ensureService: async () => ({ url: "http://127.0.0.1:4096" }),
    createClient: () => ({
      config: {
        get: async () => { throw new Error("config unavailable"); },
      },
      event: {
        subscribe: async function* () {
          yield { type: "plugin.updated" };
        },
      },
      plugin: {
        list: async () => ({
          data: ++reads < 3 ? [] : [{
            id: "workbench",
            source: { type: "local", path: "workbench-plugin.ts" },
            features: { server: true },
            state: { status: "active" },
          }],
        }),
      },
    } as never),
    stopService: async () => undefined,
    warn: message => warnings.push(message),
  });

  await controller.acquire();
  assert.deepEqual(warnings, ["OpenCode companion configuration could not be inspected: config unavailable"]);
  await controller.dispose();
});

test("aborts acquisition and disposes without waiting for service discovery", async () => {
  let settle!: (value: { url: string }) => void;
  const pending = new Promise<{ url: string }>(resolve => {
    settle = resolve;
  });
  const controller = new OpenCodeServiceController({
    prepareServiceDirectory: async () => undefined,
    ensureService: async () => await pending,
    createClient: () => ({
      plugin: { list: async () => ({ data: [{ id: "workbench", state: { status: "active" } }] }) },
    } as never),
    stopService: async () => undefined,
  });
  const lifetime = new AbortController();
  const acquiring = controller.acquire(lifetime.signal);
  lifetime.abort(new Error("bridge disposed"));
  await assert.rejects(acquiring, /bridge disposed/u);
  await controller.dispose();
  settle({ url: "http://127.0.0.1:4096" });
  await assert.rejects(controller.acquire(), /has been disposed/u);
});
