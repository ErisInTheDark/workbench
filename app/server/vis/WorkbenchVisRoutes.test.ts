/* No production exports. Protect the vis origin: only admitted requests reach a daemon, only the owning daemon this app reaches is asked, and the page's own policy survives the hop. */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchDaemonSource from "../workspace/WorkbenchDaemonSource";
import WorkbenchVisRoutes from "./WorkbenchVisRoutes";

const DAEMON = DaemonIdSchema.parse("11111111-1111-4111-8111-111111111111");
const SESSION = "22222222-2222-4222-8222-222222222222";

async function fixture(context: TestContext, proven: (headers: http.IncomingHttpHeaders) => boolean = () => false) {
  const fetched: string[] = [];
  const source = {
    id: DAEMON, httpOrigin: "http://127.0.0.1:9", available: true,
    retain: () => () => undefined, subscribe: () => () => undefined,
  } as unknown as WorkbenchDaemonSource;
  const routes = new WorkbenchVisRoutes({
    sources: { get: id => id === DAEMON ? source : null },
    network: {
      ingress: headers => proven(headers) ? { deviceNodeId: "device", manageApp: true, manageNetwork: false, trustHost: false } : null,
    },
    warn: () => undefined,
    fetcher: async input => {
      fetched.push(String(input));
      return new Response("<p>page</p>", { headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'" } });
    },
  });
  const server = http.createServer((request, response) => void routes.handle(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { fetched, get: (path: string, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, { headers }) };
}

test("a vis page streams from the daemon that owns it, path and query intact, keeping the page's policy", async context => {
  const f = await fixture(context);
  const response = await f.get(`/${DAEMON}/${SESSION}/live/static/a%20b.png?wb-r=3`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), "default-src 'self'");
  const forwarded = new URL(f.fetched[0]!);
  assert.equal(forwarded.pathname, `/daemon/vis/${SESSION}/live/static/a%20b.png`);
  assert.equal(forwarded.searchParams.get("wb-r"), "3");
  assert.equal(forwarded.searchParams.get("wb-daemon"), DAEMON);
});

test("forwarded requests without valid relay proof, daemons this app cannot reach, and other paths never reach a daemon", async context => {
  const f = await fixture(context);
  assert.equal((await f.get(`/${DAEMON}/${SESSION}/live/`, { "x-workbench-network-token": "forged" })).status, 403);
  assert.equal((await f.get(`/33333333-3333-4333-8333-333333333333/${SESSION}/live/`)).status, 503);
  assert.equal((await f.get("/api/workbench-app-port")).status, 404, "no app route is reachable from the vis origin");
  assert.deepEqual(f.fetched, []);
});

test("a forwarded request the relay proved is served", async context => {
  const f = await fixture(context, headers => headers["x-workbench-network-token"] === "a".repeat(64));
  const proof = { "x-workbench-network-token": "a".repeat(64), "x-workbench-network-device": "device" };
  assert.equal((await f.get(`/${DAEMON}/${SESSION}/live/`, proof)).status, 200);
});
