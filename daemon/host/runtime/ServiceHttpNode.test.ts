/* No production exports. Protect non-waking descriptor negotiation and daemon-bound forwarding. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WorkbenchDaemonIdentitySchema } from "../../../shared/http/workbench-daemon-discovery.ts";
import { ServiceHttp } from "./ServiceHttpNode.ts";

test("identity negotiation publishes real endpoints without changing legacy response", async context => {
  const daemonId = "063e3626-50f7-4635-950e-cdff695d0bc1";
  let wakeCount = 0;
  const owner = new ServiceHttp({
    identity: () => ({ protocol: 1, daemonId, hostname: "peer", state: "sleeping", wakeEnabled: true }),
    ingressToken: "a".repeat(64),
    daemonTarget: async () => { wakeCount++; return "http://127.0.0.1:1"; },
    warn: () => {},
    control: () => {},
  }, {
    browserEndpoints: () => ({
      httpOrigin: "http://100.64.1.2:52739",
      secureOrigin: "https://peer.wb.inthedark.boo:32123",
    }),
  });
  const server = createServer((request, response) => { void owner.handle(request, response); });
  context.after(async () => {
    owner.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const identityPath = `${origin}/_workbench-service/identity`;
  const legacy = WorkbenchDaemonIdentitySchema.parse(await (await fetch(identityPath)).json());
  assert.equal(legacy.daemonId, daemonId);
  const rawLegacy = await (await fetch(identityPath)).json();
  assert.ok(rawLegacy && typeof rawLegacy === "object");
  assert.equal("endpoints" in rawLegacy, false);
  const modern = await (await fetch(identityPath, { headers: { "x-workbench-identity-version": "2" } })).json();
  assert.deepEqual(modern, {
    identity: legacy,
    endpoints: { httpOrigin: "http://100.64.1.2:52739", secureOrigin: "https://peer.wb.inthedark.boo:32123" },
  });
  assert.equal((await fetch(`${origin}/some-asset?wb-daemon=wrong`)).status, 409);
  assert.equal(wakeCount, 0, "identity probes and mismatched targets never wake the daemon");
});
