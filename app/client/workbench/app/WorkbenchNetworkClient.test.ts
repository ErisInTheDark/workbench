/* No exports. Protect pushed network facts, HTTPS identity fencing and connection handoffs. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";
import WorkbenchNetworkClient from "./WorkbenchNetworkClient";
import { createWorkspaceClientFixture } from "./workspace-client-fixture";

function networkSnapshot(): WorkbenchNetworkSnapshot {
  return {
    configuration: { mode: "localhost", hostServe: { enabled: false, port: 8080 }, members: [], privateAccess: null },
    runtime: {
      hostServe: { phase: "off", message: null, url: null },
      privateAccess: {
        phase: "off", message: null, url: null, hostname: null, nodeId: null,
        keyFingerprint: null, loginUrl: null, addresses: [], rootCertificate: null,
        rootFingerprint: null, certificateExpiresAt: null, pending: [],
      },
    },
    executable: { available: true, message: null }, hostPlatform: "win32", busy: false, failure: null,
  };
}

function browser(context: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const navigations: string[] = [];
  const location = { href: "http://127.0.0.1:4200/settings", origin: "http://127.0.0.1:4200",
    assign: (href: string) => { navigations.push(href); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location, history: { state: null, replaceState: () => {} },
  } });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return { navigations, location };
}

async function fixture(context: TestContext, snapshot: WorkbenchNetworkSnapshot, fetcher?: typeof fetch) {
  const connection = createWorkspaceClientFixture();
  const client = new WorkbenchNetworkClient({ workspace: connection.workspace, fetcher });
  context.after(() => { client.close(); connection.dispose(); });
  const socket = await connection.open();
  await client.start();
  const observation = await socket.request("workspace/observe", 0, request => request.params.query.kind === "network");
  let revision = 0;
  const publish = async () => {
    const payload = { kind: "network" as const, data: snapshot, phase: "current" as const, failure: null };
    await socket.observation(observation, payload, ++revision);
  };
  await publish();
  return { client, socket, observation, publish };
}

async function settledVerification(client: WorkbenchNetworkClient) {
  if (client.snapshot().verification.phase === "checking") {
    await new Promise<void>(resolve => {
      const release = client.subscribe(() => {
        if (client.snapshot().verification.phase !== "checking") { release(); resolve(); }
      });
    });
  }
  return client.snapshot().verification;
}

test("pushed network facts and import notices share the app connection; close releases only their interest", async context => {
  const snapshot = networkSnapshot();
  const { client, socket, observation, publish } = await fixture(context, snapshot, async () => {
    throw new Error("Network reads must not use HTTP.");
  });
  const failures: number[] = [];
  client.subscribePresentationImport(status => { if (status.phase === "partial") failures.push(status.failed); });
  socket.event({ kind: "presentation-import", status: { phase: "partial", scanned: 2, imported: 1, failed: 1 } });
  assert.deepEqual(failures, [1]);
  snapshot.busy = true;
  publish();
  assert.equal(client.snapshot().snapshot?.busy, true);
  const action = client.action({ action: "daemon-discovery-refresh" });
  const request = await socket.request("app/network/action");
  socket.reply(request, { kind: "ok" });
  assert.deepEqual(await action, { kind: "ok" });
  client.close();
  const release = await socket.request("workspace/release");
  assert.equal(release.params.subscriptionId, observation.params.subscriptionId);
  assert.equal(socket.readyState, WebSocket.OPEN);
  const last = client.snapshot();
  snapshot.busy = false;
  publish();
  assert.equal(client.snapshot(), last);
});

test("HTTPS proof follows service identity, does not retry on progress, and fences late proof", async context => {
  browser(context);
  const snapshot = networkSnapshot();
  snapshot.configuration.mode = "tailnet-service";
  snapshot.configuration.privateAccess = { role: "authority", label: "desktop", enabled: true };
  Object.assign(snapshot.runtime.privateAccess, { phase: "starting", hostname: "desktop.wb.inthedark.boo",
    nodeId: "app", rootCertificate: "certificate", rootFingerprint: "a".repeat(64) });
  let checks = 0;
  let trusted = false;
  let delayed: Promise<Response> | null = null;
  let delayedSignal: AbortSignal | null | undefined;
  const { client, publish } = await fixture(context, snapshot, async (_input, options) => {
    if (options?.method === "POST") { trusted = true; return Response.json({ kind: "ok" }); }
    checks++;
    if (delayed) {
      const pending = delayed; delayed = null; delayedSignal = options?.signal;
      return await pending;
    }
    if (!trusted) throw new TypeError("Failed to fetch");
    return Response.json({ hostname: snapshot.runtime.privateAccess.hostname, nodeId: "app" });
  });
  assert.equal(checks, 0);
  Object.assign(snapshot.runtime.privateAccess, { phase: "ready", url: "https://desktop.wb.inthedark.boo" });
  publish();
  assert.equal((await settledVerification(client)).phase, "failed");
  publish(); publish();
  assert.equal(checks, 1);
  await client.action({ action: "trust-host" });
  assert.equal((await settledVerification(client)).phase, "verified");
  const old = Promise.withResolvers<Response>();
  delayed = old.promise;
  const checking = client.verify();
  Object.assign(snapshot.runtime.privateAccess, { hostname: "current.wb.inthedark.boo", url: "https://current.wb.inthedark.boo" });
  publish();
  assert.equal(delayedSignal?.aborted, true);
  const current = await settledVerification(client);
  assert.ok(current.phase === "verified");
  assert.equal(current.identity.hostname, "current.wb.inthedark.boo");
  old.resolve(Response.json({ hostname: "desktop.wb.inthedark.boo", nodeId: "app" }));
  await checking;
  assert.deepEqual(client.snapshot().verification, current);
  client.close();
  const count = checks;
  await client.verify();
  assert.equal(checks, count);
});

test("HTTPS verification rejects a different installation", async context => {
  const snapshot = networkSnapshot();
  Object.assign(snapshot.runtime.privateAccess, { phase: "setup", hostname: "desktop.wb.inthedark.boo",
    nodeId: "expected", rootCertificate: "certificate", rootFingerprint: "a".repeat(64) });
  let response = { hostname: "desktop.wb.inthedark.boo", nodeId: "different" };
  const { client } = await fixture(context, snapshot, async () => Response.json(response));
  await client.verify();
  const mismatch = client.snapshot().verification;
  assert.ok(mismatch.phase === "failed");
  assert.match(mismatch.message, /different/);
  response = { ...response, nodeId: "expected" };
  await client.verify();
  assert.equal(client.snapshot().verification.phase, "verified");
});

test("enabling a higher mode follows pushed readiness but waits for browser HTTPS trust", async context => {
  const { location, navigations } = browser(context);
  const snapshot = networkSnapshot();
  snapshot.configuration.privateAccess = { role: "authority", label: "desktop", enabled: false };
  snapshot.runtime.hostServe = { phase: "ready", message: null, url: "http://100.80.0.2:8080" };
  Object.assign(snapshot.runtime.privateAccess, { phase: "ready", hostname: "desktop.wb.inthedark.boo",
    url: "https://desktop.wb.inthedark.boo", nodeId: "app", rootCertificate: "certificate",
    rootFingerprint: "a".repeat(64) });
  let selected: "tailnet-ip" | "tailnet-service" = "tailnet-ip";
  let trusted = false;
  let checks = 0;
  const f = await fixture(context, snapshot, async (input, options) => {
    if (String(input).startsWith("https:")) {
      checks++;
      if (!trusted) throw new TypeError("Failed to fetch");
      return Response.json({ hostname: "desktop.wb.inthedark.boo", nodeId: "app" });
    }
    const action = JSON.parse(String(options?.body)) as { action: string };
    if (action.action === "settings-prepare") return Response.json({
      kind: "handoff", token: "d479a147-899e-4332-8855-7b219e652aab", origin: location.origin, returning: false,
    });
    snapshot.configuration.mode = selected;
    f.publish();
    return Response.json({ kind: "settings-saved", origin: location.origin });
  });
  await f.client.changeSettings({ mode: selected, localPort: 4200, tailnetPort: 8080 });
  assert.equal(new URL(navigations[0]!).origin, "http://100.80.0.2:8080");
  location.href = navigations[0]!;
  location.origin = new URL(location.href).origin;
  selected = "tailnet-service";
  await f.client.changeSettings({ mode: selected, localPort: 4200, tailnetPort: 8080 });
  assert.equal((await settledVerification(f.client)).phase, "failed");
  assert.equal(navigations.length, 1);
  f.publish();
  assert.equal(checks, 1);
  trusted = true;
  await f.client.verify();
  assert.equal(new URL(navigations[1]!).origin, "https://desktop.wb.inthedark.boo");
  snapshot.configuration.mode = "localhost";
  snapshot.runtime.hostServe = { phase: "starting", message: null, url: null };
  f.publish();
  selected = "tailnet-ip";
  await f.client.changeSettings({ mode: selected, localPort: 4200, tailnetPort: 8080 });
  assert.equal(navigations.length, 2);
  snapshot.runtime.hostServe = { phase: "ready", message: null, url: "http://100.80.0.3:8080" };
  f.publish();
  assert.equal(new URL(navigations[2]!).origin, "http://100.80.0.3:8080");
});

test("another-device eligibility follows committed app grants rather than another app or the local host", async context => {
  const snapshot = networkSnapshot();
  snapshot.configuration.group = { id: "67e323d5-949a-4c41-956f-1fa28905f034", revision: 1,
    ownerNodeId: "app", dnsNodeId: "app", access: "selected", grants: [] };
  snapshot.runtime.host = { hostname: "desktop", address: "100.80.0.2", nodeId: "host" };
  snapshot.runtime.privateAccess.nodeId = "app";
  const { client, publish } = await fixture(context, snapshot);
  const group = snapshot.configuration.group;
  assert.equal(client.canAccessFromAnotherDevice(), false);
  group.grants = [{ deviceNodeId: "host", appNodeId: "app" }, { deviceNodeId: "phone", appNodeId: "other-app" }];
  publish();
  assert.equal(client.canAccessFromAnotherDevice(), false);
  group.grants.push({ deviceNodeId: "phone", appNodeId: "app" });
  publish();
  assert.equal(client.canAccessFromAnotherDevice(), true);
});

test("handoff navigates before finishing, retains partial failures, and disposal fences late navigation", async context => {
  const { location, navigations } = browser(context);
  const actions: string[] = [];
  const token = "d479a147-899e-4332-8855-7b219e652aab";
  const origin = "http://100.80.0.2:8089";
  const client = new WorkbenchNetworkClient({ fetcher: async (_input, options) => {
    actions.push((JSON.parse(String(options?.body)) as { action: string }).action);
    return Response.json(actions.length === 1 ? { kind: "handoff", token, origin, returning: false }
      : actions.length === 2 ? { kind: "settings-pending", token, origin, message: "Forwarding could not finish." }
      : { kind: "settings-saved", origin });
  } });
  context.after(() => client.close());
  await client.changeSettings({ mode: "tailnet-ip", localPort: 4200, tailnetPort: 8089 });
  assert.deepEqual(actions, ["settings-prepare"]);
  location.origin = origin; location.href = navigations[0]!;
  await client.finishSettings();
  assert.equal(client.snapshot().handoff?.manual, true);
  assert.ok(client.snapshot().error);
  await client.finishSettings();
  assert.equal(client.snapshot().handoff, null);
  assert.equal(client.snapshot().error, null);
  const response = Promise.withResolvers<Response>();
  const disposed = new WorkbenchNetworkClient({ fetcher: async () => response.promise });
  const changing = disposed.changeSettings({ mode: "tailnet-ip", localPort: 4200, tailnetPort: 8080 });
  disposed.close();
  response.resolve(Response.json({ kind: "handoff", token, origin, returning: false }));
  await assert.rejects(changing, /closed/i);
  assert.equal(navigations.length, 1);
});
