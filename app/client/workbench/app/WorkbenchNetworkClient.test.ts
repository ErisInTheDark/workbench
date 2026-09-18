/* No production exports. Protect disposal and remote schema admission for network settings. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchNetworkClient from "./WorkbenchNetworkClient.ts";
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";

test("closing the client aborts its read and cannot publish a late response", async () => {
  let release!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const client = new WorkbenchNetworkClient({
    fetcher: async (_input, options) => { signal = options?.signal; return await pending; },
    events: () => { throw new Error("Closed client must not subscribe."); },
  });
  const starting = client.start();
  client.close();
  assert.equal(signal?.aborted, true);
  const old = client.snapshot();
  release(new Response("{}", { headers: { "Content-Type": "application/json" } }));
  await starting;
  assert.equal(client.snapshot(), old);
});

test("invalid remote data does not enter settings state or expose its payload", async () => {
  const previousError = console.error;
  const reports: string[] = [];
  console.error = (...values) => { reports.push(values.join(" ")); };
  try {
    const client = new WorkbenchNetworkClient({
      fetcher: async () => new Response('{"secret":"PRIVATE"}', { headers: { "Content-Type": "application/json" } }),
      events: () => { throw new Error("Invalid initial data must not subscribe."); },
    });
    await client.start();
    assert.equal(client.snapshot().snapshot, null);
    assert.ok(client.snapshot().error);
    assert.ok(!JSON.stringify(client.snapshot()).includes("PRIVATE"));
    assert.ok(reports.length > 0);
    assert.ok(reports.every(report => !report.includes("PRIVATE")));
    client.close();
  } finally { console.error = previousError; }
});

test("HTTPS verification must reach the expected node and disposal closes the progress stream", async () => {
  const snapshot: WorkbenchNetworkSnapshot = {
    configuration: { hostServe: { enabled: false, port: 8080 }, privateAccess: { role: "authority", label: "desktop", enabled: false }, members: [] },
    runtime: {
      hostServe: { phase: "off", message: null, url: null },
      privateAccess: {
        phase: "setup", message: null, url: null, hostname: "desktop.wb.inthedark.boo", nodeId: "expected", keyFingerprint: null,
        loginUrl: null, addresses: ["100.80.0.1"], rootCertificate: "public certificate", rootFingerprint: "a".repeat(64),
        certificateExpiresAt: null, pending: [],
      },
    },
    executable: { available: true, message: null }, hostPlatform: "win32", busy: false, failure: null,
  };
  let nodeId = "different";
  let closed = false;
  const stream: Pick<EventSource, "close" | "onmessage" | "onerror"> = { close: () => { closed = true; }, onmessage: null, onerror: null };
  const client = new WorkbenchNetworkClient({
    fetcher: async input => String(input).startsWith("https:")
      ? Response.json({ hostname: snapshot.runtime.privateAccess.hostname, nodeId })
      : Response.json(snapshot),
    events: () => stream,
  });
  await client.start();
  await assert.rejects(client.verify(), /different/u);
  nodeId = "expected";
  await client.verify();
  client.close();
  assert.equal(closed, true);
});
