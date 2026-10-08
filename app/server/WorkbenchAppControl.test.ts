/*
 * No production exports. Protect private app control, port movement and the existing Quit owner.
 */
import assert from "node:assert/strict";
import WorkbenchTemporaryDirectory from "../../shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import WorkbenchAppControl from "./WorkbenchAppControl.ts";
import { readServiceEndpoint } from "../../shared/process/workbench-service-endpoint.ts";
import { IDLE_RELOAD_OPERATION } from "../../shared/reload/workbench-reload.ts";

test("app control authenticates, follows port movement and routes Quit once", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-app-control-");
  const root = temporary.path;
  const endpointPath = path.join(root, "runtime.json");
  let quitCount = 0;
  let quit!: () => void;
  const quitted = new Promise<void>(resolve => { quit = resolve; });
  const control = new WorkbenchAppControl({
    root, endpointPath, quit: () => { quitCount++; quit(); },
    warn: message => assert.fail(message),
  });
  const servers: http.Server[] = [];
  const listen = async () => {
    const server = http.createServer((request, response) => {
      if (!control.handle(request, response)) { response.writeHead(404); response.end(); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  context.after(async () => {
    await control.close();
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
    await temporary.dispose();
  });
  const firstOrigin = await listen();
  await control.publish(firstOrigin);
  const first = await readServiceEndpoint(endpointPath);
  assert.ok(first);
  const headers = { Authorization: `Bearer ${first.token}` };
  assert.equal((await fetch(`${firstOrigin}/_workbench-control/process`)).status, 403);
  assert.equal((await fetch(`${firstOrigin}/_workbench-control/process`, {
    headers: { ...headers, "x-workbench-network-device": "remote" },
  })).status, 403);
  const nextOrigin = await listen();
  await control.publish(nextOrigin);
  const next = await readServiceEndpoint(endpointPath);
  assert.equal(next?.instanceId, first.instanceId);
  assert.equal(next?.origin, nextOrigin);
  const health = await fetch(`${nextOrigin}/_workbench-control/health`, { headers });
  const identity = await health.json() as { origin: string; token?: string };
  assert.equal(identity.origin, nextOrigin);
  assert.equal(identity.token, undefined);
  const wrong = await fetch(`${nextOrigin}/_workbench-control/quit/00000000-0000-4000-8000-000000000000`, { method: "POST", headers });
  assert.equal(wrong.status, 404);
  assert.equal(quitCount, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response: Response = await fetch(`${nextOrigin}/_workbench-control/quit/${first.instanceId}`, { method: "POST", headers });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  }
  await quitted;
  assert.equal(quitCount, 1);
});

test("private runtime, update and launch-url endpoints require local admission and resolve callbacks per request", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-app-control-");
  const endpointPath = path.join(temporary.path, "runtime.json");
  let ready = false;
  let dirty = true;
  const listeners = new Set<() => void>();
  let released!: () => void;
  const unsubscribed = new Promise<void>(resolve => { released = resolve; });
  const requests: Array<boolean | "reloadAll"> = [];
  let started!: () => void;
  let completed = new Promise<void>(resolve => { started = resolve; });
  const admission = () => ({
    cancel: () => assert.fail("Unexpected cancellation."),
    start: async () => { started(); },
  });
  let launchUrl: string | null = null;
  const control = new WorkbenchAppControl({
    root: temporary.path, endpointPath, quit: () => assert.fail("Unexpected Quit."),
    warn: message => assert.fail(message),
    readLaunchUrl: () => launchUrl,
    readRuntime: () => ready ? Promise.resolve({
      dirty, destructive: false, update: null, operation: IDLE_RELOAD_OPERATION,
    }) : null,
    subscribeRuntime: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); released(); };
    },
    reloadAll: () => {
      if (!ready) return null;
      requests.push("reloadAll");
      return admission();
    },
    pull: reload => {
      if (!ready) return null;
      requests.push(reload);
      return admission();
    },
  });
  const server = http.createServer((request, response) => {
    if (!control.handle(request, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await control.close();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await temporary.dispose();
  });
  await control.publish(origin);
  const endpoint = await readServiceEndpoint(endpointPath);
  assert.ok(endpoint);
  const headers = { Authorization: `Bearer ${endpoint.token}` };
  for (const [route, method] of [["runtime", "GET"], ["runtime/events", "GET"], ["reload-all", "POST"], ["pull", "POST"]]) {
    const url = `${origin}/_workbench-control/${route}`;
    assert.equal((await fetch(url, { method })).status, 403);
    assert.equal((await fetch(url, { method,
      headers: { ...headers, "x-workbench-network-device": "remote" } })).status, 403);
    const options = { method, headers, ...(route === "pull" ? { body: '{"reload":true}' } : {}) };
    assert.equal((await fetch(url, options)).status, 503);
  }
  assert.deepEqual(requests, []);
  const launch = `${origin}/_workbench-control/launch-url`;
  assert.equal((await fetch(launch)).status, 403);
  assert.equal((await fetch(launch, { headers: { ...headers, "x-workbench-network-device": "remote" } })).status, 403);
  assert.deepEqual(await (await fetch(launch, { headers })).json(), { url: null });
  launchUrl = "https://desk.wb.inthedark.boo/launch";
  assert.deepEqual(await (await fetch(launch, { headers })).json(), { url: launchUrl });
  ready = true;
  const runtime = await fetch(`${origin}/_workbench-control/runtime`, { headers });
  assert.equal(runtime.status, 200);
  assert.equal((await runtime.json() as { dirty: boolean }).dirty, true);
  const invalid = await fetch(`${origin}/_workbench-control/pull`, { method: "POST", headers, body: '{"reload":"yes"}' });
  assert.equal(invalid.status, 400);
  const reload = await fetch(`${origin}/_workbench-control/reload-all`, { method: "POST", headers });
  assert.equal(reload.status, 202);
  await completed;
  completed = new Promise<void>(resolve => { started = resolve; });
  const pull = await fetch(`${origin}/_workbench-control/pull`, { method: "POST", headers, body: '{"reload":false}' });
  assert.equal(pull.status, 202);
  await completed;
  assert.deepEqual(requests, ["reloadAll", false]);
  const stream = await fetch(`${origin}/_workbench-control/runtime/events`, { headers });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const nextEvent = async () => {
    while (!buffered.includes("\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buffered += decoder.decode(chunk.value, { stream: true });
    }
    const end = buffered.indexOf("\n\n");
    const event = buffered.slice(0, end);
    buffered = buffered.slice(end + 2);
    return JSON.parse(event.replace(/^data: /u, "")) as { dirty: boolean };
  };
  assert.equal((await nextEvent()).dirty, true);
  dirty = false;
  for (const listener of [...listeners]) listener();
  assert.equal((await nextEvent()).dirty, false);
  await reader.cancel();
  await unsubscribed;
  assert.equal(listeners.size, 0);
  const finalStream = await fetch(`${origin}/_workbench-control/runtime/events`, { headers });
  const finalReader = finalStream.body!.getReader();
  assert.equal((await finalReader.read()).done, false);
  await control.close();
  assert.equal((await finalReader.read()).done, true);
  assert.equal(listeners.size, 0);
});
