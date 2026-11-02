/*
 * No production exports. Tests protect single dispatch: only apps reaching the target are asked, an app that refuses before
 * dispatching lets the next one try, a request an app took is never sent again, and lookups continue across apps.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { RelayPresence, RelayRequest } from "workbench-shared/workbench/network/network-relay-contracts";
import ProcessNetworkRelay, { type RelayState } from "./network-relay-process-state";
import WorkbenchNetworkRelayController, { RelayOutcomeUnknownError, RelayUnavailableError } from "./WorkbenchNetworkRelayController";

const self = DaemonIdSchema.parse("11111111-1111-4111-8111-111111111111");
const target = DaemonIdSchema.parse("22222222-2222-4222-8222-222222222222");
const execute: RelayRequest = {
  kind: "execute", targetDaemonId: target, caller: { threadId: WorkbenchThreadIdSchema.parse("caller"), title: "caller" },
  call: { kind: "release" },
};
const presence = (daemons: string[], standby = false): RelayPresence => ({
  self: { daemonId: self, hostname: "a" }, standby, daemons: daemons.map(daemonId => ({ daemonId: DaemonIdSchema.parse(daemonId), hostname: "x" })),
});

function harness() {
  const sent: Array<{ client: object; requestId: string }> = [];
  const timers: Array<() => void> = [];
  const state: RelayState = { presence: new Map(), pending: new Map(), send: null, listeners: new Set() };
  const relay = new WorkbenchNetworkRelayController(state, {
    schedule: run => { timers.push(run); return run; },
    cancel: timer => { const index = timers.indexOf(timer as () => void); if (index >= 0) timers.splice(index, 1); },
  });
  const kernel = new ProcessNetworkRelay(state);
  kernel.attachTransport((client, message) => {
    sent.push({ client, requestId: (message as { params: { requestId: string } }).params.requestId });
  });
  return { kernel, relay, sent, timers };
}

test("an execute goes only to apps that reach its target, and answers from the first that does", async () => {
  const { relay, sent } = harness();
  const blind = {};
  const reaching = {};
  relay.acceptPresence(blind, presence([self]));
  relay.acceptPresence(reaching, presence([self, target]));
  const answer = relay.request(execute, new AbortController().signal);
  await Promise.resolve();
  assert.deepEqual(sent.map(item => item.client), [reaching]);
  relay.acceptResult(reaching, { requestId: sent[0]!.requestId, outcome: { kind: "answered", result: { kind: "ok", text: "done", data: null } } });
  assert.deepEqual(await answer, { kind: "ok", text: "done", data: null });
});

test("an app that refuses before dispatching hands the request to the next app", async () => {
  const { relay, sent } = harness();
  const first = {};
  const second = {};
  relay.acceptPresence(first, presence([target]));
  relay.acceptPresence(second, presence([target]));
  const answer = relay.request(execute, new AbortController().signal);
  await Promise.resolve();
  relay.acceptResult(first, { requestId: sent[0]!.requestId, outcome: { kind: "unreachable", failure: "no" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[1]?.client, second);
  relay.acceptResult(second, { requestId: sent[1]!.requestId, outcome: { kind: "answered", result: { kind: "ok", text: null, data: null } } });
  assert.equal((await answer).kind, "ok");
});

test("a request an app accepted is never sent again, even when that app disconnects", async () => {
  const { kernel, relay, sent } = harness();
  const first = {};
  relay.acceptPresence(first, presence([target]));
  relay.acceptPresence({}, presence([target]));
  const answer = relay.request(execute, new AbortController().signal);
  await Promise.resolve();
  relay.acceptResult(first, { requestId: sent[0]!.requestId, outcome: { kind: "accepted" } });
  kernel.disconnect(first);
  await assert.rejects(answer, RelayOutcomeUnknownError);
  assert.equal(sent.length, 1);
});

test("a call no app accepts in time is not retried elsewhere, but a read is", async () => {
  const { relay, sent, timers } = harness();
  relay.acceptPresence({}, presence([target]));
  relay.acceptPresence({}, presence([target]));
  const call = relay.request(execute, new AbortController().signal);
  await Promise.resolve();
  timers.shift()!();
  await assert.rejects(call, RelayOutcomeUnknownError);
  assert.equal(sent.length, 1);

  const read = relay.request({ kind: "summary", threadIds: ["thread"] }, new AbortController().signal);
  await Promise.resolve();
  timers.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 3);
  void read.catch(() => undefined);
});

test("a lookup one app cannot complete continues with the next app, keeping what each found", async () => {
  const { relay, sent } = harness();
  const own = {};
  const wider = {};
  relay.acceptPresence(own, presence([self]));
  relay.acceptPresence(wider, presence([self, target]));
  const found = { kind: "thread" as const, daemonId: target, hostname: "x", threadId: "remote", title: "Remote", projectName: "p", daemonProject: false };
  const answer = relay.request({ kind: "resolve", targets: [{ kind: "thread", threadId: "remote" }] }, new AbortController().signal);
  await Promise.resolve();
  relay.acceptResult(own, { requestId: sent[0]!.requestId, outcome: { kind: "answered", result: { targets: [{ kind: "failed", failure: "not here" }] } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[1]?.client, wider);
  relay.acceptResult(wider, { requestId: sent[1]!.requestId, outcome: { kind: "answered", result: { targets: [{ kind: "resolved", target: found }] } } });
  assert.deepEqual(await answer, { targets: [{ kind: "resolved", target: found }] });
});

test("results from another connection cannot answer a request", async () => {
  const { relay, sent } = harness();
  const asked = {};
  relay.acceptPresence(asked, presence([target]));
  const caller = new AbortController();
  const answer = relay.request(execute, caller.signal);
  await Promise.resolve();
  relay.acceptResult({}, { requestId: sent[0]!.requestId, outcome: { kind: "answered", result: { kind: "ok", text: "forged", data: null } } });
  caller.abort(new Error("caller gave up"));
  await assert.rejects(answer, /caller gave up/u);
});

test("without any app there is nothing to dispatch to, and standby connections are named as such", async () => {
  const { kernel, relay } = harness();
  await assert.rejects(relay.request(execute, new AbortController().signal), RelayUnavailableError);
  const standby = {};
  relay.acceptPresence(standby, presence([target], true));
  assert.equal(kernel.standbyOnly(standby), true);
  assert.equal(relay.self()?.daemonId, self);
});
