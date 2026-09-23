/*
 * No production exports. Protect logical matching without confusing it with execution ownership.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonIdSchema, ProjectIdentityKeySchema } from "../identity.ts";
import { logicalProjectMatchKey } from "./project-location.ts";

test("network remotes match across daemons while local and file identities do not", () => {
  const first = DaemonIdSchema.parse("4f29787d-5a30-4c4c-9d1f-224913a3468c");
  const second = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
  const remote = ProjectIdentityKeySchema.parse("remote://example.test/owner/repo");
  const local = ProjectIdentityKeySchema.parse("local://C:/repo/.git");
  const file = ProjectIdentityKeySchema.parse("remote://file:/C:/repo");
  const workspace = ProjectIdentityKeySchema.parse("workspace://members");
  assert.equal(logicalProjectMatchKey(first, remote, [remote]), logicalProjectMatchKey(second, remote, [remote]));
  assert.notEqual(logicalProjectMatchKey(first, local, [local]), logicalProjectMatchKey(second, local, [local]));
  assert.notEqual(logicalProjectMatchKey(first, file, [file]), logicalProjectMatchKey(second, file, [file]));
  assert.equal(logicalProjectMatchKey(first, workspace, [remote]), logicalProjectMatchKey(second, workspace, [remote]));
  assert.notEqual(logicalProjectMatchKey(first, workspace, [remote, local]),
    logicalProjectMatchKey(second, workspace, [remote, local]));
});
