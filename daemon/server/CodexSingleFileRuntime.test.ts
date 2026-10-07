/* No exports. Tests protect the dedicated native handshake and scratch ownership. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import createCodexSingleFileRuntime from "./CodexSingleFileRuntime";

test("first voice preparation creates its isolated process directory before native send", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("voice-spawn-");
  try {
    const runtime = createCodexSingleFileRuntime({
      documentsDirectory: "/unused",
      transformerDirectory: path.join(temporary.path, "transformer"),
      createServer: options => ({
      send(message) {
        assert.equal(existsSync(options.projectRoot), true);
        const request = message as { id?: number };
        if (request.id !== undefined) options.onMessage({ id: request.id, result: {} });
      },
      async stopAsync() {},
      }),
    });
    const transport = runtime.createTransport(async () => {}, error => { throw error; });
    try {
      await transport.request({ method: "initialize", params: {
        clientInfo: { name: "voice-test", title: null, version: "1" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      } });
    } finally { await transport.dispose(); }
  } finally {
    await temporary.dispose();
  }
});

test("an unavailable transformer directory rejects preparation before native spawn", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("voice-blocked-");
  context.after(() => temporary.dispose());
  await fs.writeFile(path.join(temporary.path, "blocker"), "file");
  let sent = false;
  const runtime = createCodexSingleFileRuntime({
    documentsDirectory: "/unused",
    transformerDirectory: path.join(temporary.path, "blocker", "transformer"),
    createServer: () => ({ send() { sent = true; }, async stopAsync() {} }),
  });
  const transport = runtime.createTransport(async () => {}, error => { throw error; });
  try {
    await assert.rejects(transport.request({ method: "initialize", params: {
      clientInfo: { name: "voice-test", title: null, version: "1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    } }));
    assert.equal(sent, false);
  } finally { await transport.dispose(); }
});

test("initialization acknowledges readiness before later native requests", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("voice-init-");
  context.after(() => temporary.dispose());
  const methods: string[] = [];
  const runtime = createCodexSingleFileRuntime({
    documentsDirectory: "/unused", transformerDirectory: path.join(temporary.path, "transformer"),
    createServer: options => ({
    send(message) {
      const request = message as { id?: number; method: string };
      methods.push(request.method);
      if (request.id !== undefined) options.onMessage({ id: request.id, result: {} });
    },
    async stopAsync() {},
    }),
  });
  const transport = runtime.createTransport(async () => {}, error => { throw error; });
  await transport.request({
    method: "initialize",
    params: {
      clientInfo: { name: "voice-test", title: null, version: "1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    },
  });
  assert.deepEqual(methods, ["initialize", "initialized"]);
  await transport.dispose();
});

test("scratch disposal retains history without affecting another active document", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("voice-test-");
  const root = temporary.path;
  context.after(() => temporary.dispose());
  const runtime = createCodexSingleFileRuntime({ documentsDirectory: root });
  const first = await runtime.createDocument("first");
  const second = await runtime.createDocument("second");
  try {
    assert.notEqual(first.directory, second.directory);
    await first.dispose();
    assert.equal(await first.read(), "first");
    assert.equal(await second.read(), "second");
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
  }
});

test("native process failure rejects pending and future work without silently restarting", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("voice-failure-");
  context.after(() => temporary.dispose());
  let fail!: () => void;
  let sent = 0;
  const dispatched = Promise.withResolvers<void>();
  const failures: Error[] = [];
  const runtime = createCodexSingleFileRuntime({
    documentsDirectory: "/unused", transformerDirectory: path.join(temporary.path, "transformer"),
    createServer: options => {
    fail = () => options.onFatalExit("exited", { retry: true });
    return { send() { sent++; dispatched.resolve(); }, async stopAsync() {} };
    },
  });
  const transport = runtime.createTransport(async () => {}, error => failures.push(error));
  const request = { method: "config/read", params: { includeLayers: false } } as const;
  const pending = transport.request(request);
  const rejected = assert.rejects(pending, /exited/);
  await dispatched.promise;
  fail();
  await rejected;
  const later = transport.request(request);
  // A retained failure must reject before dispatch, not create another unanswered RPC.
  assert.equal(sent, 1);
  await assert.rejects(later, /exited/);
  assert.equal(failures.length, 1);
  await transport.dispose();
});

test("edited scratch contents cannot exceed the receiving document contract", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("voice-test-");
  const root = temporary.path;
  context.after(() => temporary.dispose());
  const document = await createCodexSingleFileRuntime({ documentsDirectory: root }).createDocument("original");
  try {
    await fs.writeFile(document.file, "x".repeat(1_000_001), "utf8");
    await assert.rejects(document.read());
  } finally { await document.dispose(); }
});

test("thread admission disables inherited MCP servers while preserving caller restrictions", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("voice-thread-");
  context.after(() => temporary.dispose());
  const configurations: object[] = [];
  const runtime = createCodexSingleFileRuntime({
    documentsDirectory: "/unused", transformerDirectory: path.join(temporary.path, "transformer"),
    createServer: options => ({
    send(message) {
      const request = message as { id: number; method: string; params: { config?: object } };
      if (request.method === "thread/start") configurations.push(request.params.config!);
      options.onMessage({ id: request.id, result: request.method === "config/read"
        ? { config: { mcp_servers: { personal: { command: "private" }, workbench: { url: "private" } } } }
        : {} });
    },
    async stopAsync() {},
    }),
  });
  const transport = runtime.createTransport(async () => {}, error => { throw error; });
  try {
    await transport.request({ method: "thread/start", params: {
      cwd: "/scratch", config: { model_reasoning_effort: "none", project_doc_max_bytes: 0 },
    } });
    assert.deepEqual(configurations, [{
      model_reasoning_effort: "none", project_doc_max_bytes: 0,
      mcp_servers: { personal: { enabled: false }, workbench: { enabled: false } },
    }]);
  } finally { await transport.dispose(); }
});
