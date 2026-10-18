/*
 * No production exports. Real HTTP wards protect the MCP sign-in callback: it reaches the named daemon once,
 * announces the outcome, and never echoes provider or query text unescaped.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import HttpServer from "workbench-shared/http/HttpServer";
import type { McpServerSignInFinishParams, McpServerSignInFinishResult } from "workbench-shared/workbench/mcp/mcp-server-settings";

import WorkbenchMcpSignInRoutes, { type McpSignInEvent } from "./WorkbenchMcpSignInRoutes";

const DAEMON = "00000000-0000-4000-8000-0000000000da";

async function fixture(context: TestContext, sources: Record<string, {
  available: boolean;
  finish(params: McpServerSignInFinishParams): Promise<McpServerSignInFinishResult>;
}>) {
  const events: McpSignInEvent[] = [];
  const routes = new WorkbenchMcpSignInRoutes({
    sources: {
      get: id => {
        const source = sources[id];
        return source ? { available: source.available, daemon: { mcpServers: { finishSignIn: source.finish } } } : null;
      },
    },
    warn: () => undefined,
  });
  routes.subscribe(event => events.push(event));
  const server = new HttpServer({
    handleRequest: async (request, response) => {
      if (!await routes.handle(request, response, new URL(request.url ?? "/", "http://workbench.local"))) response.writeHead(404).end();
    },
    hostname: "127.0.0.1",
  });
  context.after(async () => await server.close());
  const address = await server.start();
  return { events, get: (path: string) => fetch(`${address.url}${path}`) };
}

test("a provider code reaches its daemon once and the popup closes itself on success", async context => {
  const received: McpServerSignInFinishParams[] = [];
  const { events, get } = await fixture(context, {
    [DAEMON]: { available: true, finish: async params => { received.push(params); return { outcome: "signedIn", server: "composio" }; } },
  });
  const response = await get(`/api/mcp-sign-in/${DAEMON}?code=abc&state=state-value-0123456789`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Signed in to composio/u);
  assert.match(html, /window\.close\(\)/u);
  assert.deepEqual(received, [{ state: "state-value-0123456789", code: "abc" }]);
  assert.deepEqual(events, [{ daemonId: DAEMON, outcome: "signedIn" }]);
});

test("an offline daemon is reported without forwarding or announcing anything", async context => {
  const { events, get } = await fixture(context, {
    [DAEMON]: { available: false, finish: async () => assert.fail("must not forward to an offline daemon") },
  });
  const response = await get(`/api/mcp-sign-in/${DAEMON}?code=abc&state=state-value-0123456789`);
  assert.equal(response.status, 503);
  assert.deepEqual(events, []);
});

test("a provider error is relayed as a failure and hostile text stays escaped", async context => {
  const hostile = "<script>alert(1)</script>";
  const received: McpServerSignInFinishParams[] = [];
  const { events, get } = await fixture(context, {
    [DAEMON]: {
      available: true,
      finish: async params => { received.push(params); return { outcome: "failed", server: "composio", detail: "error" in params ? params.error : "" }; },
    },
  });
  const response = await get(`/api/mcp-sign-in/${DAEMON}?state=state-value-0123456789&error=${encodeURIComponent(hostile)}`);
  const html = await response.text();
  assert.equal(response.status, 400);
  assert.deepEqual(received, [{ state: "state-value-0123456789", error: hostile }]);
  assert.equal(html.includes(hostile), false);
  assert.match(html, /&#60;script&#62;/u);
  assert.equal(html.includes("window.close"), false);
  assert.deepEqual(events, [{ daemonId: DAEMON, outcome: "failed" }]);
});
