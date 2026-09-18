/* No production exports. Protect disposal and remote schema admission for network settings. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchNetworkClient from "./WorkbenchNetworkClient.ts";
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";

test("enabling a higher mode upgrades the address, but HTTPS waits for browser trust", async context => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const navigations: string[] = [];
  const location = { href: "http://127.0.0.1:4200/settings", origin: "http://127.0.0.1:4200",
    assign: (href: string) => { navigations.push(href); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location } });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const snapshot: WorkbenchNetworkSnapshot = {
    configuration: { mode: "localhost", hostServe: { enabled: false, port: 8080 }, members: [],
      privateAccess: { role: "authority", label: "desktop", enabled: false } },
    runtime: {
      hostServe: { phase: "ready", message: null, url: "http://100.80.0.2:8080" },
      privateAccess: { phase: "ready", message: null, url: "https://desktop.wb.inthedark.boo",
        hostname: "desktop.wb.inthedark.boo", nodeId: "app", keyFingerprint: null, loginUrl: null,
        addresses: [], rootCertificate: "public certificate", rootFingerprint: "a".repeat(64), certificateExpiresAt: null, pending: [] },
    },
    executable: { available: true, message: null }, hostPlatform: "win32", busy: false, failure: null,
  };
  const stream: Pick<EventSource, "close" | "onmessage" | "onerror"> = { close: () => {}, onmessage: null, onerror: null };
  const publish = () => {
    const receive: ((event: MessageEvent) => void) | null = stream.onmessage;
    receive?.({ data: JSON.stringify(snapshot) } as MessageEvent);
  };
  let selected: "tailnet-ip" | "tailnet-service" = "tailnet-ip";
  let trusted = false;
  let checks = 0;
  let verificationResponse: Promise<Response> | null = null;
  let verificationStarted = () => {};
  let verificationSignal: AbortSignal | null | undefined;
  const client = new WorkbenchNetworkClient({ events: () => stream, fetcher: async (input, options) => {
    if (String(input).startsWith("https:")) {
      checks++;
      verificationSignal = options?.signal;
      verificationStarted();
      if (verificationResponse) return await verificationResponse;
      if (!trusted) throw new TypeError("Failed to fetch");
      return Response.json({ hostname: "desktop.wb.inthedark.boo", nodeId: "app" });
    }
    if (!options?.body) return Response.json(snapshot);
    const action = JSON.parse(String(options.body)) as { action: string };
    if (action.action === "settings-prepare") return Response.json({
      kind: "handoff", token: "d479a147-899e-4332-8855-7b219e652aab", origin: location.origin, returning: false,
    });
    snapshot.configuration.mode = selected;
    publish();
    return Response.json({ kind: "settings-saved", origin: location.origin });
  } });
  context.after(() => client.close());
  await client.start();
  assert.equal(navigations.length, 0);
  await client.changeSettings({ mode: selected, localPort: 4200, tailnetPort: 8080 });
  assert.equal(navigations.length, 1);
  assert.equal(new URL(navigations[0]!).origin, "http://100.80.0.2:8080");
  location.href = navigations[0]!;
  location.origin = new URL(location.href).origin;
  selected = "tailnet-service";
  await client.changeSettings({ mode: selected, localPort: 4200, tailnetPort: 8080 });
  assert.equal(checks, 1);
  assert.equal(navigations.length, 1, "untrusted HTTPS must not strand the browser");
  assert.match(client.snapshot().error ?? "", /certificate/);
  publish();
  assert.equal(checks, 1, "progress must not repeatedly retry failed trust checks");
  trusted = true;
  await client.verify();
  assert.equal(navigations.length, 2);
  assert.equal(new URL(navigations[1]!).origin, "https://desktop.wb.inthedark.boo");
  assert.equal(new URL(navigations[1]!).pathname, "/settings");

  snapshot.configuration.mode = "localhost";
  snapshot.runtime.hostServe = { phase: "starting", message: null, url: null };
  publish();
  location.href = "http://127.0.0.1:4200/settings";
  location.origin = "http://127.0.0.1:4200";
  selected = "tailnet-ip";
  await client.changeSettings({ mode: selected, localPort: 4200, tailnetPort: 8080 });
  assert.equal(navigations.length, 2, "wait for the newly enabled listener");
  snapshot.runtime.hostServe = { phase: "ready", message: null, url: "http://100.80.0.2:8080" };
  publish();
  assert.equal(navigations.length, 3, "readiness completes the pending upgrade");

  selected = "tailnet-service";
  snapshot.runtime.privateAccess.phase = "starting";
  await client.changeSettings({ mode: selected, localPort: 4200, tailnetPort: 8080 });
  snapshot.configuration.mode = "tailnet-ip";
  publish();
  snapshot.runtime.privateAccess.phase = "ready";
  snapshot.configuration.mode = "tailnet-service";
  publish();
  assert.equal(checks, 2, "a mode change cancels the old upgrade instead of reviving it later");
  assert.equal(navigations.length, 3);

  snapshot.configuration.mode = "tailnet-ip";
  publish();
  let finishVerification!: (response: Response) => void;
  verificationResponse = new Promise<Response>(resolve => { finishVerification = resolve; });
  const entered = new Promise<void>(resolve => { verificationStarted = resolve; });
  const changing = client.changeSettings({ mode: "tailnet-service", localPort: 4200, tailnetPort: 8080 });
  await entered;
  client.close();
  assert.equal(verificationSignal?.aborted, true);
  finishVerification(Response.json({ hostname: "desktop.wb.inthedark.boo", nodeId: "app" }));
  await changing;
  assert.equal(navigations.length, 3, "a disposed client cannot navigate on late verification success");
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
