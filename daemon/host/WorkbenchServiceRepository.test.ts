/*
 * No production exports. Tests durable service identity and session-scoped restart intent.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import WorkbenchTemporaryDirectory from "../../shared/WorkbenchTemporaryDirectory.ts";
import test from "node:test";
import WorkbenchServiceRepository from "./WorkbenchServiceRepository.ts";

test("service identity and wake policy survive repository reopening", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-service-db-");
  const root = temporary.path;
  const databasePath = path.join(root, "service.sqlite3");
  const first = new WorkbenchServiceRepository({ databasePath });
  const next = new WorkbenchServiceRepository({ databasePath });
  context.after(async () => {
    await first.close();
    await next.close();
    await temporary.dispose();
  });
  await first.start();
  const identity = first.daemonId;
  assert.match(identity, /^[0-9a-f-]{36}$/u);
  assert.equal(first.wakeEnabled, false);
  first.setWakeEnabled(true);
  await first.close();
  await next.start();
  assert.equal(next.daemonId, identity);
  assert.equal(next.wakeEnabled, true);
});

test("restart intent wakes only its supervision session", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-service-intent-");
  const root = temporary.path;
  const repository = new WorkbenchServiceRepository({ databasePath: path.join(root, "service.sqlite3") });
  context.after(async () => {
    await repository.close();
    await temporary.dispose();
  });
  await repository.start();
  assert.equal(repository.shouldResume("session-a"), false);
  repository.requestDaemon("session-a");
  assert.equal(repository.shouldResume("session-a"), true);
  assert.equal(repository.shouldResume("session-b"), false);
  repository.stopDaemon();
  assert.equal(repository.shouldResume("session-a"), false);
  assert.equal(repository.wakeEnabled, false);
  repository.requestDaemon("session-a");
  assert.equal(repository.shouldResume("session-a"), true);
});
