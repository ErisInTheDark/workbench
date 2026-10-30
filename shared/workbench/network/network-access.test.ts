/*
 * No production exports. Tests protect when a networked thread is restricted to its summary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema, ProjectIdSchema } from "../identity.ts";
import { ThreadNetworkAccess } from "./network-access.ts";

const a = DaemonIdSchema.parse("11111111-1111-4111-8111-111111111111");
const b = DaemonIdSchema.parse("22222222-2222-4222-8222-222222222222");

test("a thread stays restricted for every daemon it ever reached, revoked or not, and its remote parent", () => {
  const history = [{ target: { kind: "folder" as const, daemonId: b, hostname: "b", projectId: ProjectIdSchema.parse("project"), rootPath: "/p" } }];
  const networked = ThreadNetworkAccess.daemonIds(history, a);
  assert.deepEqual(networked, [a, b].sort());
  assert.equal(ThreadNetworkAccess.isRestricted(networked, new Set([a])), true);
  assert.equal(ThreadNetworkAccess.isRestricted(networked, new Set([a, b])), false);
  assert.equal(ThreadNetworkAccess.isRestricted(undefined, new Set()), false);
});
