/*
 * No production exports. Tests bounded private publication and process-bound verification.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { publishServiceEndpoint, readServiceEndpoint, removeServiceEndpoint, verifyServiceEndpoint } from "./workbench-service-endpoint.ts";

test("service withdrawal cannot remove another process publication", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-service-endpoint-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "endpoint.json");
  const endpoint = { version: 1 as const, instanceId: randomUUID(), pid: 1234, origin: "http://127.0.0.1:1234", token: "a".repeat(64) };
  await publishServiceEndpoint(file, endpoint);
  await removeServiceEndpoint(file, randomUUID());
  assert.deepEqual(await readServiceEndpoint(file), endpoint);
  await removeServiceEndpoint(file, endpoint.instanceId);
  assert.equal(await readServiceEndpoint(file), null);
});

test("service verification rejects a reused port and oversized health output", async () => {
  const endpoint = { version: 1 as const, instanceId: randomUUID(), pid: 1234, origin: "http://127.0.0.1:1234", token: "a".repeat(64) };
  const { token, ...health } = endpoint;
  await verifyServiceEndpoint(endpoint, undefined, async (_url, options) => {
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`);
    return Response.json(health);
  });
  await assert.rejects(verifyServiceEndpoint(endpoint, undefined, async () => Response.json({
    ...health, instanceId: randomUUID(),
  })), /identity/i);
  await assert.rejects(verifyServiceEndpoint(endpoint, undefined, async () => new Response("x".repeat(16_385))), /size/i);
});
