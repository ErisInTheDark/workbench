/* No production exports. Protect disposal and remote schema admission for network settings. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchNetworkClient from "./WorkbenchNetworkClient.ts";
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";

test("access saves once, or navigates before applying a self-revoking policy", async context => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const navigations: string[] = [];
  const location = { href: "https://desktop.wb.inthedark.boo/settings", origin: "https://desktop.wb.inthedark.boo",
    assign: (href: string) => { navigations.push(href); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location } });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const actions: string[] = [];
  let handoff = false;
  const client = new WorkbenchNetworkClient({ fetcher: async (_input, options) => {
    const action = JSON.parse(String(options?.body)) as { action: string };
    actions.push(action.action);
    if (action.action === "settings-finish") return Response.json({ error: "Policy revision changed." }, { status: 409 });
    return Response.json(handoff
      ? { kind: "handoff", token: "d479a147-899e-4332-8855-7b219e652aab", origin: "http://127.0.0.1:4200", returning: false }
      : { kind: "ok" });
  } });
  context.after(() => client.close());
  const policy = { revision: 1, access: "selected" as const, grants: [] };
  await client.changeAccess(policy);
  assert.deepEqual(actions, ["access-prepare"]);
  assert.equal(navigations.length, 0);
  handoff = true;
  await client.changeAccess(policy);
  assert.deepEqual(actions, ["access-prepare", "access-prepare"]);
  const url = new URL(navigations[0]!);
  assert.equal(url.origin, "http://127.0.0.1:4200");
  assert.equal(url.searchParams.get("workbenchNetworkPanel"), "access");
  location.origin = url.origin;
  location.href = url.href;
  await assert.rejects(client.finishSettings(), /revision/);
  assert.equal(client.snapshot().handoff, null, "failed access draft must not trap the editor in retry mode");
  assert.equal(navigations.length, 1, "stay on safe loopback after a policy failure");
});

test("another-device eligibility follows committed app grants rather than this host or another app", async context => {
  const snapshot: WorkbenchNetworkSnapshot = {
    configuration: { hostServe: { enabled: true, port: 8080 }, privateAccess: null, members: [],
      group: { id: "67e323d5-949a-4c41-956f-1fa28905f034", revision: 1, ownerNodeId: "app", dnsNodeId: "app", access: "selected", grants: [] } },
    runtime: {
      host: { hostname: "desktop", address: "100.80.0.2", nodeId: "host" },
      hostServe: { phase: "ready", message: null, url: "http://100.80.0.2:8080" },
      privateAccess: { phase: "ready", message: null, url: null, hostname: null, nodeId: "app", keyFingerprint: null,
        loginUrl: null, addresses: [], rootCertificate: null, rootFingerprint: null, certificateExpiresAt: null, pending: [] },
    },
    executable: { available: true, message: null }, hostPlatform: "win32", busy: false, failure: null,
  };
  const stream: Pick<EventSource, "close" | "onmessage" | "onerror"> = { close: () => {}, onmessage: null, onerror: null };
  const client = new WorkbenchNetworkClient({ fetcher: async () => Response.json(snapshot), events: () => stream });
  context.after(() => client.close());
  await client.start();
  const group = snapshot.configuration.group!;
  const publish = () => {
    const receive: ((event: MessageEvent) => void) | null = stream.onmessage;
    receive?.({ data: JSON.stringify(snapshot) } as MessageEvent);
  };
  assert.equal(client.canAccessFromAnotherDevice(), false);
  group.grants = [{ deviceNodeId: "host", appNodeId: "app" }, { deviceNodeId: "phone", appNodeId: "other-app" }];
  publish();
  assert.equal(client.canAccessFromAnotherDevice(), false);
  group.grants.push({ deviceNodeId: "phone", appNodeId: "app" });
  publish();
  assert.equal(client.canAccessFromAnotherDevice(), true);
  group.grants = [];
  group.access = "all";
  publish();
  assert.equal(client.canAccessFromAnotherDevice(), true);
});

test("settings handoff navigates before finishing and leaves partial failures for explicit retry", async context => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const navigations: string[] = [];
  const location = { href: "https://desktop.wb.inthedark.boo/project?settings=network", origin: "https://desktop.wb.inthedark.boo",
    assign: (href: string) => { navigations.push(href); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location } });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const actions: string[] = [];
  const token = "d479a147-899e-4332-8855-7b219e652aab";
  const destination = "http://100.80.0.2:8089";
  const client = new WorkbenchNetworkClient({ fetcher: async (_input, options) => {
    const action = JSON.parse(String(options?.body)) as { action: string };
    actions.push(action.action);
    return Response.json(actions.length === 1 ? { kind: "handoff", token, origin: destination, returning: false }
      : actions.length === 2 ? { kind: "settings-pending", token, origin: destination, message: "Forwarding could not finish." }
      : { kind: "settings-saved", origin: destination });
  } });
  context.after(() => client.close());
  await client.changeSettings({ mode: "tailnet-ip", localPort: 4200, tailnetPort: 8089 });
  assert.deepEqual(actions, ["settings-prepare"]);
  assert.equal(new URL(navigations[0]!).origin, destination);
  assert.equal(new URL(navigations[0]!).pathname, "/project");
  location.origin = destination;
  location.href = navigations[0]!;
  await client.finishSettings();
  assert.deepEqual(actions, ["settings-prepare", "settings-finish"]);
  assert.equal(client.snapshot().handoff?.manual, true);
  assert.ok(client.snapshot().error);
  await client.finishSettings();
  assert.equal(client.snapshot().handoff, null);
  assert.equal(client.snapshot().error, null);
  assert.equal(navigations.length, 1);
});

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

test("disposing an action owner prevents late handoff navigation", async () => {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>(done => { resolve = done; });
  const client = new WorkbenchNetworkClient({ fetcher: async () => await response });
  const changing = client.changeSettings({ mode: "tailnet-ip", localPort: 4200, tailnetPort: 8080 });
  client.close();
  resolve(Response.json({ kind: "handoff", token: "d479a147-899e-4332-8855-7b219e652aab",
    origin: "http://100.80.0.2:8080", returning: false }));
  await assert.rejects(changing, /closed/i);
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
  let unreachable = false;
  let requests = 0;
  let closed = false;
  const stream: Pick<EventSource, "close" | "onmessage" | "onerror"> = { close: () => { closed = true; }, onmessage: null, onerror: null };
  const client = new WorkbenchNetworkClient({
    fetcher: async input => { requests++; if (unreachable) throw new TypeError("Failed to fetch"); return String(input).startsWith("https:")
      ? Response.json({ hostname: snapshot.runtime.privateAccess.hostname, nodeId })
      : Response.json(snapshot); },
    events: () => stream,
  });
  await client.start();
  unreachable = true;
  await assert.rejects(client.verify(), error => error instanceof Error && /certificate/i.test(error.message) && /DNS/.test(error.message));
  assert.equal(client.snapshot().verified, null);
  unreachable = false;
  await assert.rejects(client.verify(), /different/u);
  nodeId = "expected";
  await client.verify();
  assert.equal(client.snapshot().verified?.nodeId, "expected");
  snapshot.runtime.privateAccess.hostname = "renamed.wb.inthedark.boo";
  const receive: ((event: MessageEvent) => void) | null = stream.onmessage;
  receive?.({ data: JSON.stringify(snapshot) } as MessageEvent);
  assert.equal(client.snapshot().verified, null);
  client.close();
  assert.equal(closed, true);
  const before = requests;
  await assert.rejects(client.verify());
  assert.equal(requests, before, "disposed client must not begin another verification");
});
