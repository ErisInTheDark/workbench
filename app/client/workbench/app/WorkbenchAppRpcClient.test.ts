/* No production exports. Protect independent app connection facts and non-replayed mutations. */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";
import { createWorkspaceClientFixture } from "./workspace-client-fixture";

test("the transport rejects an undispatched mutation without waiting behind startup", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  await assert.rejects(fixture.rpc.requestRaw({ method: "app/settings/read", params: {} }),
    error => error instanceof WorkbenchRpcRequestInterruptedError && !error.dispatched);
  assert.equal(fixture.sockets.length, 0);
  await fixture.open();
  assert.equal(fixture.rpc.connected, true);
});

test("an initial import warning reaches a later settings subscriber", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  socket.event({ kind: "presentation-import", status: { phase: "partial", scanned: 2, imported: 1, failed: 1 } });
  const observed: number[] = [];
  fixture.rpc.onEvent(event => {
    if (event.kind === "presentation-import") observed.push(event.status.failed);
  });
  assert.deepEqual(observed, [1]);
});

test("repairable app event drift reaches late listeners as conformed data without exposing values", async context => {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (message: string) => warnings.push(message));
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
    kind: "presentation-import", future: "private-value",
    status: { phase: "partial", scanned: 2, imported: 1, failed: 1, future: "private-value" },
  }) }));
  const observed: object[] = [];
  fixture.rpc.onEvent(event => observed.push(event));
  assert.deepEqual(observed, [{
    kind: "presentation-import", status: { phase: "partial", scanned: 2, imported: 1, failed: 1 },
  }]);
  assert.ok(warnings.some(message => message.includes("status.future")));
  assert.ok(!warnings.join("\n").includes("private-value"));
});

test("transcript event predicates deliver the repaired payload rather than the original object", async context => {
  context.mock.method(console, "warn", () => {});
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const observed: object[] = [];
  fixture.rpc.onEvent(event => observed.push(event));
  for (const event of [
    { kind: "transcriptSnapshot", data: {
      subscriptionId: "transcript", stream: "workbench:transcript", snapshot: null,
    } },
    { kind: "transcriptStream", data: { subscriptionId: "transcript", update: { kind: "absent" } } },
  ]) {
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ ...event, data: { ...event.data, future: "private-value" } }),
    }));
    assert.deepEqual(observed.at(-1), event);
  }
  assert.equal(observed.length, 2);
});

test("socket loss reports uncertain dispatch and reconnect never replays the mutation", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const pending = fixture.rpc.requestRaw({ method: "app/state/mutate",
    params: { browserStateId: null, mutation: { action: "put",
      record: { kind: "globalPreference", preference: { key: "theme", value: "winter" } } } } });
  const failed = assert.rejects(pending,
    error => error instanceof WorkbenchRpcRequestInterruptedError && error.dispatched);
  await socket.request("app/state/mutate");
  socket.close();
  await failed;
  context.mock.timers.tick(60_000);
  const replacement = await fixture.nextSocket(1);
  const connected = fixture.workspace.connect();
  replacement.open();
  await connected;
  assert.deepEqual(replacement.sent, []);
  const read = fixture.rpc.requestRaw({ method: "app/settings/read", params: {} });
  const request = await replacement.request("app/settings/read");
  replacement.reply(request, { reactDevelopmentMode: true });
  await read;
  assert.equal(socket.sent.filter(item => item.method === "app/state/mutate").length, 1);
});
