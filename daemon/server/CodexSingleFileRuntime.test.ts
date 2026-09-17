/* No exports. Tests protect the dedicated native handshake and scratch ownership. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import createCodexSingleFileRuntime from "./CodexSingleFileRuntime";

test("initialization acknowledges readiness before later native requests", async () => {
  const methods: string[] = [];
  const runtime = createCodexSingleFileRuntime(options => ({
    send(message) {
      const request = message as { id?: number; method: string };
      methods.push(request.method);
      if (request.id !== undefined) options.onMessage({ id: request.id, result: {} });
    },
    async stopAsync() {},
  }));
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

test("scratch disposal cannot affect a different owned document", async () => {
  const runtime = createCodexSingleFileRuntime();
  const first = await runtime.createDocument("first");
  const second = await runtime.createDocument("second");
  try {
    assert.notEqual(first.directory, second.directory);
    await first.dispose();
    await assert.rejects(first.read(), { code: "ENOENT" });
    assert.equal(await second.read(), "second");
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
  }
});

test("native process failure rejects pending and future work without silently restarting", async () => {
  let fail!: () => void;
  let sent = 0;
  const failures: Error[] = [];
  const runtime = createCodexSingleFileRuntime(options => {
    fail = () => options.onFatalExit("exited");
    return { send() { sent++; }, async stopAsync() {} };
  });
  const transport = runtime.createTransport(async () => {}, error => failures.push(error));
  const request = { method: "config/read", params: { includeLayers: false } } as const;
  const pending = transport.request(request);
  const rejected = assert.rejects(pending, /exited/);
  fail();
  await rejected;
  const later = transport.request(request);
  // A retained failure must reject before dispatch, not create another unanswered RPC.
  assert.equal(sent, 1);
  await assert.rejects(later, /exited/);
  assert.equal(failures.length, 1);
  await transport.dispose();
});

test("edited scratch contents cannot exceed the receiving document contract", async () => {
  const document = await createCodexSingleFileRuntime().createDocument("original");
  try {
    await fs.writeFile(document.file, "x".repeat(1_000_001), "utf8");
    await assert.rejects(document.read());
  } finally { await document.dispose(); }
});

test("thread admission disables inherited MCP servers while preserving caller restrictions", async () => {
  const configurations: object[] = [];
  const runtime = createCodexSingleFileRuntime(options => ({
    send(message) {
      const request = message as { id: number; method: string; params: { config?: object } };
      if (request.method === "thread/start") configurations.push(request.params.config!);
      options.onMessage({ id: request.id, result: request.method === "config/read"
        ? { config: { mcp_servers: { personal: { command: "private" }, workbench: { url: "private" } } } }
        : {} });
    },
    async stopAsync() {},
  }));
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
