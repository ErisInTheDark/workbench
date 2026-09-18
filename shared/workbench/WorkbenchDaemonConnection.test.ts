/* No production exports. Protect local-port refresh, tailnet addressing and late-resolution disposal fencing. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchDaemonConnection from "./WorkbenchDaemonConnection.ts";

test("local reconnects read the new bound port while tailnet addresses keep the publication port", async () => {
  let port = 32123;
  let location = "http://127.0.0.1:3002/launch";
  const owner = new WorkbenchDaemonConnection({
    location: () => location, fetcher: async () => Response.json({ localPort: port, tailnetPort: 52739 }),
  });
  assert.equal(await owner.resolve(), "ws://127.0.0.1:32123");
  port = 32124;
  assert.equal(await owner.resolve(), "ws://127.0.0.1:32124");
  for (const hostname of ["localhost", "[::1]", "127.0.0.2"]) {
    location = `http://${hostname}:3002/launch`;
    assert.equal(await owner.resolve(), "ws://127.0.0.1:32124");
  }
  location = "http://100.80.0.2:8080/launch";
  assert.equal(await owner.resolve(), "ws://100.80.0.2:52739");
  location = "https://desktop.wb.inthedark.boo/launch";
  assert.equal(await owner.resolve(), "wss://desktop.wb.inthedark.boo:52739");
  owner.dispose();
});

test("missing daemon publication does not guess a port and explicit external URLs remain independent", async () => {
  let configured: string | null = null;
  const owner = new WorkbenchDaemonConnection({
    location: () => "http://localhost:3002", configuredUrl: () => configured,
    fetcher: async () => Response.json({ localPort: null, tailnetPort: 52739 }),
  });
  await assert.rejects(owner.resolve(), /unavailable/u);
  assert.equal(owner.getSnapshot().url, null);
  configured = "wss://daemon.example.test:1234";
  assert.equal(await owner.resolve(), configured);
  owner.dispose();
});

test("coalesced callers cannot publish a late endpoint after browser disposal", async () => {
  let complete!: (response: Response) => void;
  let calls = 0;
  const owner = new WorkbenchDaemonConnection({
    location: () => "http://localhost:3002",
    fetcher: () => { calls++; return new Promise(resolve => { complete = resolve; }); },
  });
  const first = owner.resolve();
  const second = owner.resolve();
  assert.equal(calls, 1);
  owner.dispose();
  complete(Response.json({ localPort: 32123, tailnetPort: 52739 }));
  await assert.rejects(first);
  await assert.rejects(second);
  assert.equal(owner.getSnapshot().url, null);
});
