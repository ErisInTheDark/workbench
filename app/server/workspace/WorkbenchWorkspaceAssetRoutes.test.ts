/* No exports. Protect verified asset routing, cache semantics and independent cancellation. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import type WorkbenchDaemonSources from "./WorkbenchDaemonSources";
import WorkbenchWorkspaceAssetRoutes from "./WorkbenchWorkspaceAssetRoutes";

const daemonId = "10000000-0000-4000-8000-000000000001";
const assetPath = `/api/workspace/assets/${daemonId}/daemon/transcript-assets/thread/${"a".repeat(64)}.png`;

async function fixture(context: TestContext, fetcher: typeof fetch) {
  let origin: string | null = "https://verified-daemon.example";
  let retained = 0;
  const listeners = new Set<() => void>();
  const warnings: string[] = [];
  const completed = Promise.withResolvers<void>();
  const source = {
    id: daemonId,
    get available() { return origin !== null; },
    get httpOrigin() { return origin; },
    retain: () => { retained++; return () => { retained--; }; },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const owner = new WorkbenchWorkspaceAssetRoutes({
    sources: { get: (id: string) => id === daemonId ? source : null } as unknown as WorkbenchDaemonSources,
    fetcher, warn: message => { warnings.push(message); },
  });
  const server = createServer((request, response) => {
    void owner.handle(request, response, new URL(request.url!, "http://local")).then(
      handled => {
        if (!handled) response.writeHead(404).end();
        completed.resolve();
      },
      error => { completed.reject(error); response.destroy(error); },
    );
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  context.after(async () => {
    owner.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return {
    url: `http://127.0.0.1:${address.port}`, owner, warnings, completed: completed.promise,
    get retained() { return retained; },
    get listeners() { return listeners.size; },
    replace(next: string | null) { origin = next; for (const listener of listeners) listener(); },
  };
}

test("asset bytes use only the verified source and preserve range/cache metadata without forwarding cookies", async context => {
  const requests: Array<{ url: URL; options?: RequestInit }> = [];
  const f = await fixture(context, async (input, options) => {
    requests.push({ url: new URL(String(input)), options });
    return new Response("image", { status: 206, headers: {
      "content-type": "image/png", "content-range": "bytes 0-4/10", etag: '"one"',
      "cache-control": "private, max-age=60", "set-cookie": "must-not-cross=sources",
    } });
  });
  const response = await fetch(`${f.url}${assetPath}?wb-daemon=forged`, {
    headers: { range: "bytes=0-4", "if-none-match": '"old"', cookie: "browser-secret=value" },
  });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "image");
  assert.equal(response.headers.get("content-range"), "bytes 0-4/10");
  assert.equal(response.headers.get("etag"), '"one"');
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(requests[0]?.url.origin, "https://verified-daemon.example");
  assert.equal(requests[0]?.url.searchParams.get("wb-daemon"), daemonId);
  const headers = new Headers(requests[0]?.options?.headers);
  assert.equal(headers.get("range"), "bytes=0-4");
  assert.equal(headers.get("if-none-match"), '"old"');
  assert.equal(headers.get("cookie"), null);
  assert.equal(requests[0]?.options?.redirect, "manual");
  await f.completed;
  assert.equal(f.retained, 0);
  assert.equal(f.listeners, 0);
});

test("cache validation returns no body while redirects fail without following an arbitrary destination", async context => {
  let redirect = false;
  let requests = 0;
  const f = await fixture(context, async () => {
    requests++;
    return redirect ? new Response(null, { status: 302, headers: { location: "https://untrusted.example" } })
      : new Response(null, { status: 304, headers: { etag: '"same"' } });
  });
  const cached = await fetch(`${f.url}${assetPath}`);
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  redirect = true;
  assert.equal((await fetch(`${f.url}${assetPath}`)).status, 502);
  assert.equal(requests, 2);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.retained, 0);
});

for (const reason of ["revoked", "replaced", "caller", "disposed"] as const) {
  test(`${reason} retires only the owned upstream asset request`, async context => {
    const entered = Promise.withResolvers<AbortSignal>();
    const f = await fixture(context, async (_input, options) => {
      const signal = options?.signal;
      assert.ok(signal);
      entered.resolve(signal);
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    });
    const caller = new AbortController();
    const response = fetch(`${f.url}${assetPath}`, { signal: caller.signal });
    const settled = response.then(value => value.status, error => error);
    const upstream = await entered.promise;
    assert.equal(f.retained, 1);
    if (reason === "revoked") f.replace(null);
    else if (reason === "replaced") f.replace("https://replacement.example");
    else if (reason === "caller") caller.abort();
    else f.owner.dispose();
    await f.completed;
    await settled;
    assert.equal(upstream.aborted, true);
    assert.equal(f.retained, 0);
    assert.equal(f.listeners, 0);
    assert.deepEqual(f.warnings, []);
  });
}
