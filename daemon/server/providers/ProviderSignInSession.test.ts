/* Exports: none. Protect that one sign-in attempt per provider ends exactly once and always stops its native flow. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderAccountIntegration } from "workbench-shared/workbench/provider/provider-account-sign-in";
import ProviderSignInSession, { type ProviderSignInFlow } from "./ProviderSignInSession";

const INTEGRATION: ProviderAccountIntegration = {
  id: "account", label: "Account", primary: true, signedIn: false, accountLabel: null,
  methods: [{ id: "browser", label: "Browser", kind: "browser" }, { id: "key", label: "Key", kind: "key" }],
};

function fixture() {
  const timers: (() => void)[] = [];
  const flows: { flow: ProviderSignInFlow; succeed(): void; fail(error: Error): void; cancelled: number; signal: AbortSignal }[] = [];
  const keys: string[] = [];
  let ids = 0;
  const session = new ProviderSignInSession({
    provider: "test",
    now: () => 0,
    createId: () => `attempt-${++ids}`,
    schedule: (_delay, callback) => {
      timers.push(callback);
      return () => { timers.splice(timers.indexOf(callback), 1); };
    },
    adapter: {
      read: async () => [INTEGRATION],
      begin: async (_integration, _method, signal) => {
        let succeed!: () => void;
        let fail!: (error: Error) => void;
        const settled = new Promise<void>((resolve, reject) => { succeed = resolve; fail = reject; });
        const entry = {
          succeed, fail, cancelled: 0, signal,
          flow: { url: "https://example.test", userCode: null, acceptsCode: false, expiresAt: null, settled,
            cancel: async () => { entry.cancelled++; } },
        };
        flows.push(entry);
        return entry.flow;
      },
      connectKey: async (_integration, _method, key) => { keys.push(key); },
      signOut: async () => undefined,
    },
  });
  return { session, flows, timers, keys };
}

const start = (session: ProviderSignInSession) => session.start({ integrationId: "account", methodId: "browser" });

test("a provider's success ends the attempt and releases its waiters", async () => {
  const { session, flows, timers } = fixture();
  const { attempt } = await start(session);
  const waiting = session.wait(attempt!.id);
  flows[0]!.succeed();
  assert.equal((await waiting).attempt?.state, "succeeded");
  assert.equal(flows[0]!.signal.aborted, true);
  assert.deepEqual(timers, []);
});

test("starting again, even concurrently, joins the same attempt", async () => {
  const { session, flows } = fixture();
  const [first, concurrent] = await Promise.all([start(session), start(session)]);
  const second = await start(session);
  assert.equal(concurrent.attempt?.id, first.attempt?.id);
  assert.equal(second.attempt?.id, first.attempt?.id);
  assert.equal(flows.length, 1);
});

test("cancel and expiry stop the native flow once and ignore its later report", async () => {
  const cancelled = fixture();
  const { attempt } = await start(cancelled.session);
  assert.equal((await cancelled.session.cancel(attempt!.id)).attempt?.state, "cancelled");
  cancelled.flows[0]!.succeed();
  await Promise.resolve();
  assert.equal((await cancelled.session.read()).attempt?.state, "cancelled");
  assert.equal(cancelled.flows[0]!.cancelled, 1);

  const expired = fixture();
  await start(expired.session);
  expired.timers[0]!();
  await Promise.resolve();
  const snapshot = await expired.session.read();
  assert.equal(snapshot.attempt?.state, "failed");
  assert.match(snapshot.attempt?.error ?? "", /expired/u);
  assert.equal(expired.flows[0]!.cancelled, 1);
});

test("a provider failure carries its message and a new start begins a fresh attempt", async () => {
  const { session, flows } = fixture();
  const first = await start(session);
  flows[0]!.fail(new Error("denied"));
  const failed = await session.wait(first.attempt!.id);
  assert.equal(failed.attempt?.error, "denied");
  const second = await start(session);
  assert.notEqual(second.attempt?.id, first.attempt?.id);
});

test("disposal cancels a pending attempt and refuses new ones", async () => {
  const { session, flows } = fixture();
  const { attempt } = await start(session);
  const waiting = session.wait(attempt!.id);
  await session.dispose();
  assert.equal((await waiting).attempt?.state, "cancelled");
  assert.equal(flows[0]!.cancelled, 1);
  await assert.rejects(start(session), /reloading/u);
});

test("key methods connect without an attempt", async () => {
  const { session, keys, flows } = fixture();
  const snapshot = await session.start({ integrationId: "account", methodId: "key", key: "secret" });
  assert.deepEqual(keys, ["secret"]);
  assert.equal(snapshot.attempt, null);
  assert.equal(flows.length, 0);
});
