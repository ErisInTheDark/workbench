/*
 * No exports. Protect daemon operations from waiting forever on a daemon that never becomes reachable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_RELOAD_METHOD } from "workbench-shared/workbench/daemon-reload";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import type { WorkspaceDaemonFact } from "workbench-shared/workbench/workspace/workspace-observation";
import type { WorkbenchDaemonObservationFact } from "../workspace/WorkbenchDaemonSource";
import { DAEMON_UNREACHABLE_LIMIT_MS, reloadDaemonScopes, type DaemonOperationSource } from "./daemon-reload-operations";

const PENDING: WorkbenchDaemonObservationFact = { phase: "pending", failure: null, value: null };

function runtimeFact(generation: number, revision: number, pendingScopes: string[] = []): WorkbenchDaemonObservationFact {
  return { phase: "current", failure: null, value: {
    kind: "runtime", subscriptionId: "runtime", generation, revision, phase: "current", failure: null,
    data: { dirtyScopes: [], pendingScopes, error: null },
  } };
}

function fakeDaemon() {
  let connection: WorkspaceDaemonFact["connection"] = "connecting";
  let fact = PENDING;
  const listeners = new Set<() => void>();
  const requests: string[] = [];
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const source: DaemonOperationSource = {
    retain: () => () => {},
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => ({
      daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001"),
      hostname: "noisybox", generation: 1, connection, failure: null,
    }),
    observe: (_query, listener) => {
      listeners.add(listener);
      return { getSnapshot: () => fact, release: () => { listeners.delete(listener); } };
    },
    request: async <Result>(method: string) => {
      requests.push(method);
      return { appliedScopes: [], completedAt: null, error: null, ok: true, queuedScopes: ["server:core"],
        requestedScopes: ["server:core"], startedAt: 1, state: "running" } as Result;
    },
  };
  return {
    source,
    requests,
    publish(next: { connection: WorkspaceDaemonFact["connection"]; fact: WorkbenchDaemonObservationFact }) {
      connection = next.connection;
      fact = next.fact;
      notify();
    },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("a daemon that never becomes reachable fails the reload, naming it, without sending anything", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const daemon = fakeDaemon();
  const reload = reloadDaemonScopes(daemon.source, ["server:core"]);
  t.mock.timers.tick(DAEMON_UNREACHABLE_LIMIT_MS);
  await assert.rejects(reload, /noisybox has not been reachable/u);
  assert.deepEqual(daemon.requests, []);
});

test("reconnecting within the allowance keeps a reload alive before and after admission", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const daemon = fakeDaemon();
  let settled = false;
  const reload = reloadDaemonScopes(daemon.source, ["server:core"]).finally(() => { settled = true; });

  t.mock.timers.tick(DAEMON_UNREACHABLE_LIMIT_MS - 1);
  daemon.publish({ connection: "current", fact: runtimeFact(1, 1, ["server:core"]) });
  await settle();
  assert.deepEqual(daemon.requests, [WORKBENCH_RELOAD_METHOD]);

  daemon.publish({ connection: "reconnecting", fact: { ...runtimeFact(1, 1, ["server:core"]), phase: "stale" } });
  t.mock.timers.tick(DAEMON_UNREACHABLE_LIMIT_MS - 1);
  await settle();
  assert.equal(settled, false);

  daemon.publish({ connection: "current", fact: runtimeFact(2, 1) });
  await reload;
  t.mock.timers.tick(DAEMON_UNREACHABLE_LIMIT_MS);
});
