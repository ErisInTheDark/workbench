/*
 * No production exports. Protect incremental MCP reads (including installing npm servers) and stale-result fencing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerSettingsSnapshot, McpServerSnapshot } from "workbench-shared/workbench/mcp/mcp-server-settings";
import McpServerSettingsController from "./McpServerSettingsController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function server(id: string): McpServerSnapshot {
  return { id, name: id, source: { kind: "http", url: `https://${id}.example/mcp` }, allowAll: false, allowedTools: [], auth: null, catalog: { status: "pending" } };
}

function setup() {
  let inventory: McpServerSettingsSnapshot = { servers: [server("fast"), server("slow")] };
  let failure: Error | null = null;
  const requests: { id: string; reply: ReturnType<typeof deferred<McpServerSettingsSnapshot>> }[] = [];
  const controller = new McpServerSettingsController({
    daemonId: "daemon",
    read: async () => { if (failure) throw failure; return inventory; },
    readServer: (id: string) => {
      const reply = deferred<McpServerSettingsSnapshot>();
      requests.push({ id, reply });
      return reply.promise;
    },
    update: async () => { if (failure) throw failure; return inventory; },
    startSignIn: async () => ({ authorizationUrl: "https://login.example" }),
    readAppPort: async () => ({ appOrigin: "http://localhost", loopbackReachable: true }),
    onSignIn: () => () => undefined,
    openPopup: () => null,
  });
  return {
    controller, requests,
    inventory: (value: McpServerSettingsSnapshot) => { inventory = value; },
    fail: (error: Error | null) => { failure = error; },
  };
}

function nextPublish(controller: McpServerSettingsController) {
  return new Promise<void>(resolve => {
    const stop = controller.subscribe(() => { stop(); resolve(); });
  });
}

test("saved cards appear before checks finish; fast replies and failures publish independently", async () => {
  const { controller, requests } = setup();
  try {
    await controller.refresh();
    assert.deepEqual(requests.map(request => request.id), ["fast", "slow"]);
    assert.equal(controller.getSnapshot().busy, false);
    assert.deepEqual(controller.getSnapshot().settings?.servers.map(server => server.catalog.status), ["pending", "pending"]);

    const fast = nextPublish(controller);
    requests[0]!.reply.resolve({ servers: [{ ...server("fast"), catalog: { status: "ready", tools: [] } }] });
    await fast;
    assert.deepEqual(controller.getSnapshot().settings?.servers.map(server => server.catalog.status), ["ready", "pending"]);

    const slow = nextPublish(controller);
    requests[1]!.reply.reject(new Error("Offline"));
    await slow;
    assert.deepEqual(controller.getSnapshot().settings?.servers.map(server => server.catalog.status), ["ready", "error"]);
    assert.equal(controller.getSnapshot().error, "");
  } finally { controller.dispose(); }
});

test("a card installing its npm package is checked until the install settles", async t => {
  const fixture = setup();
  const { controller, requests } = fixture;
  t.after(() => controller.dispose());
  fixture.inventory({ servers: [{ ...server("fast"), catalog: { status: "installing" } }, { ...server("slow"), catalog: { status: "ready", tools: [] } }] });
  await controller.refresh();
  assert.deepEqual(requests.map(request => request.id), ["fast"]);
  const installed = nextPublish(controller);
  requests[0]!.reply.resolve({ servers: [{ ...server("fast"), catalog: { status: "ready", tools: [] } }] });
  await installed;
  assert.deepEqual(controller.getSnapshot().settings?.servers.map(entry => entry.catalog.status), ["ready", "ready"]);
});

test("a newer refresh or removal fences older checks, and disposal suppresses late replies", async t => {
  const fixture = setup();
  const { controller, requests } = fixture;
  t.after(() => controller.dispose());
  await controller.refresh();
  assert.equal(requests.length, 2);
  await controller.refresh();
  assert.equal(requests.length, 4);

  const current = nextPublish(controller);
  requests[2]!.reply.resolve({ servers: [{ ...server("fast"), catalog: { status: "signInRequired" } }] });
  await current;
  requests[0]!.reply.resolve({ servers: [{ ...server("fast"), catalog: { status: "ready", tools: [] } }] });
  await requests[0]!.reply.promise;
  assert.equal(controller.getSnapshot().settings?.servers[0]?.catalog.status, "signInRequired");

  fixture.inventory({ servers: [server("fast")] });
  await controller.update({ action: "remove", id: "slow" });
  requests[3]!.reply.resolve({ servers: [{ ...server("slow"), catalog: { status: "ready", tools: [] } }] });
  await requests[3]!.reply.promise;
  assert.deepEqual(controller.getSnapshot().settings?.servers.map(server => server.id), ["fast"]);

  const beforeDispose = controller.getSnapshot();
  controller.dispose();
  requests.at(-1)!.reply.reject(new Error("Late failure"));
  await requests.at(-1)!.reply.promise.catch(() => undefined);
  assert.equal(controller.getSnapshot(), beforeDispose);
});

test("failed saves and inventory refreshes do not strand previously pending cards", async t => {
  const fixture = setup();
  const { controller, requests } = fixture;
  t.after(() => controller.dispose());
  await controller.refresh();
  assert.equal(requests.length, 2);
  fixture.fail(new Error("Save refused"));
  assert.equal(await controller.update({ action: "rename", id: "fast", name: "new-name" }), false);
  assert.equal(requests.length, 4, "pending checks resume under the new operation's fence");
  assert.equal(await controller.refresh(), false);
  assert.equal(requests.length, 6);
  const checked = nextPublish(controller);
  requests[4]!.reply.resolve({ servers: [{ ...server("fast"), catalog: { status: "ready", tools: [] } }] });
  await checked;
  assert.equal(controller.getSnapshot().settings?.servers[0]?.catalog.status, "ready");
  assert.equal(controller.getSnapshot().error, "Save refused");
});
