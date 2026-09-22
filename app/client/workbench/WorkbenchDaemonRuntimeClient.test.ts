/*
 * No production exports. Tests protect ordered reload dirt, reconnect reset, mixed-version fallback, and user reload admission.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import {
  WORKBENCH_RELOAD_DIRT_READ_METHOD,
  WORKBENCH_RELOAD_METHOD,
} from "workbench-shared/workbench/daemon-reload";
import WorkbenchDaemonRuntimeClient from "./WorkbenchDaemonRuntimeClient.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function envelope(revision: number, scope: string) {
  return {
    revision,
    snapshot: {
      dirtyScopes: [{ description: scope, destructive: false, scope }],
      error: null as string | null,
      pendingScopes: [] as string[],
    },
  };
}

test("a newer notification cannot be rolled back by an older bootstrap response", async () => {
  const read = deferred<unknown>();
  const client = new WorkbenchDaemonRuntimeClient({
    request: async (method) => {
      assert.equal(method, WORKBENCH_RELOAD_DIRT_READ_METHOD);
      return await read.promise;
    },
  });
  const opening = client.open();
  assert.equal(client.acceptUpdate(envelope(2, "server:websocket")), true);
  read.resolve(envelope(1, "server:core"));
  assert.equal(await opening, true);
  assert.equal(client.getSnapshot().dirtyScopes[0]?.scope, "server:websocket");
});

test("connection reset admits a lower revision from the replacement server", async () => {
  const responses = [envelope(8, "server:core"), envelope(0, "server:database")];
  const client = new WorkbenchDaemonRuntimeClient({
    request: async () => responses.shift(),
  });
  await client.open();
  client.resetConnection();
  await client.open();
  assert.equal(client.getSnapshot().dirtyScopes[0]?.scope, "server:database");
});

test("only an ordered successful server reload completion notifies its owner", () => {
  const client = new WorkbenchDaemonRuntimeClient({ request: async () => ({}) });
  const completed: number[] = [];
  const unsubscribe = client.subscribeServerReloadCompleted(() => completed.push(1));
  const update = (revision: number, pendingScopes: string[], error: string | null = null) => {
    const value = envelope(revision, "server:core");
    value.snapshot.pendingScopes = pendingScopes;
    value.snapshot.error = error;
    client.acceptUpdate(value);
  };
  update(1, ["server:core"]);
  update(0, []);
  update(2, [], "reload failed");
  update(3, ["client:compiler"]);
  update(4, []);
  update(5, ["server:database"]);
  update(5, []);
  client.resetConnection();
  update(0, []);
  assert.deepEqual(completed, []);
  update(1, ["server:core"]);
  update(2, []);
  assert.deepEqual(completed, [1]);
  unsubscribe();
  update(3, ["server:core"]);
  update(4, []);
  assert.deepEqual(completed, [1]);
});

test("an old server enables legacy thread dirt without hiding unsupported reads", async () => {
  const client = new WorkbenchDaemonRuntimeClient({
    request: async () => {
      throw new WorkbenchDaemonRequestError("Method not found.", -32601);
    },
  });
  assert.equal(await client.open(), false);
  client.acceptLegacy({
    dirtyScopes: [{ description: "Core", destructive: false, scope: "server:core" }],
    error: null,
    pendingScopes: [],
  });
  assert.equal(client.getSnapshot().dirtyScopes[0]?.scope, "server:core");
});

test("reload admission stays on the runtime owner and conforms its response", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = new WorkbenchDaemonRuntimeClient({
    request: async (method, params) => {
      requests.push({ method, params });
      return {
        appliedScopes: [],
        completedAt: null,
        error: null,
        ok: true,
        queuedScopes: ["server:core"],
        requestedScopes: ["server:core"],
        startedAt: 1,
        state: "running",
      };
    },
  });
  assert.equal((await client.reloadScopes(["server:core"])).state, "running");
  assert.deepEqual(requests, [{
    method: WORKBENCH_RELOAD_METHOD,
    params: { scopes: ["server:core"] },
  }]);
});
