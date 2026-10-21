/*
 * No production exports. Protects reload scope routing and the process/install replacement subsumption rules.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { partitionReloadScopes } from "./reload-scope-partition.ts";

test("routes each namespace to its owner", () => {
  assert.deepEqual(partitionReloadScopes(["client:http", "server:core"]), {
    client: ["client:http"],
    server: ["server:core"],
  });
});

test("full app restart subsumes client reloads without swallowing daemon scopes", () => {
  assert.deepEqual(partitionReloadScopes(["client:http", "client:process", "server:core"]), {
    client: ["client:process"],
    server: ["server:core"],
  });
});

test("host and app process replacement subsume only their own graph", () => {
  assert.deepEqual(partitionReloadScopes([
    "host:http", "client:http", "host:process", "client:process", "server:core",
  ]), {
    client: ["host:process", "client:process"],
    server: ["server:core"],
  });
  assert.deepEqual(partitionReloadScopes(["host:http", "client:process", "server:core"]), {
    client: ["host:http", "client:process"],
    server: ["server:core"],
  });
});

test("an app-only dependency install subsumes app scopes but leaves host and daemon reloads routed", () => {
  const scopes = ["server:core", "host:process", "client:http", "client:process", "client:install"];
  assert.deepEqual(partitionReloadScopes(scopes), {
    client: ["host:process", "client:install"],
    server: ["server:core"],
  });
  assert.deepEqual(partitionReloadScopes(scopes, { installRestartsHost: true }), {
    client: ["client:install"],
    server: [],
  });
});

test("daemon process replacement subsumes only daemon reloads", () => {
  assert.deepEqual(partitionReloadScopes(["server:core", "server:process", "client:http", "host:http"]), {
    client: ["host:http", "client:http"],
    server: ["server:process"],
  });
});
