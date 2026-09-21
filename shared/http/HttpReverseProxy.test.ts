/* No production exports. Protect request identity, mutation non-replay and owned cancellation. */
import assert from "node:assert/strict";
import test from "node:test";
import HttpServer from "./HttpServer.ts";
import HttpReverseProxy from "./HttpReverseProxy.ts";

test("forwarding keeps method and body, and never retries a rejected mutation", async context => {
  const requests: { method?: string; url?: string; body: string }[] = [];
  const upstream = new HttpServer({
    hostname: "127.0.0.1",
    handleRequest: async (request, response) => {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      requests.push({ method: request.method, url: request.url, body: Buffer.concat(body).toString() });
      response.writeHead(409, { "Content-Type": "text/plain" });
      response.end("conflict");
    },
  });
  const target = await upstream.start();
  const proxy = new HttpReverseProxy({ target: async () => target.url, warn: message => assert.fail(message) });
  const listener = new HttpServer({ hostname: "127.0.0.1", handleRequest: (request, response) => proxy.handle(request, response) });
  context.after(async () => { proxy.close(); await listener.close({ force: true }); await upstream.close({ force: true }); });
  const address = await listener.start();
  const response = await fetch(`${address.url}/mutate?project=one`, { method: "POST", body: "intent" });
  assert.equal(response.status, 409);
  assert.equal(await response.text(), "conflict");
  assert.deepEqual(requests, [{ method: "POST", url: "/mutate?project=one", body: "intent" }]);
});

test("disposing forwarding cancels endpoint admission without sending a request", async context => {
  let enter!: (signal: AbortSignal) => void;
  const entered = new Promise<AbortSignal>(resolve => { enter = resolve; });
  const proxy = new HttpReverseProxy({
    target: signal => {
      enter(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    warn: message => assert.fail(message),
  });
  const listener = new HttpServer({ hostname: "127.0.0.1", handleRequest: (request, response) => proxy.handle(request, response) });
  context.after(async () => { proxy.close(); await listener.close({ force: true }); });
  const address = await listener.start();
  const abort = new AbortController();
  const response = fetch(address.url, { signal: abort.signal });
  const rejected = assert.rejects(response);
  const admission = await entered;
  proxy.close();
  assert.equal(admission.aborted, true);
  abort.abort();
  await rejected;
});
