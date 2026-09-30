/*
 * No exports. Protect installation-routed global settings from requiring a project folder.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DaemonIdSchema } from "../identity";
import { WorkspaceCommandSchema } from "./workspace-commands";

test("global sandbox settings target a daemon installation without inventing a folder", () => {
  const scope = { kind: "installation", daemonId: DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001") };
  assert.equal(WorkspaceCommandSchema.safeParse({
    method: "sandbox-network/read", params: {}, scope,
  }).success, true);
  assert.equal(WorkspaceCommandSchema.safeParse({
    method: "sandbox-network/update",
    params: { provider: "codex", enabled: true, scope: "global" },
    scope,
  }).success, true);
  assert.equal(WorkspaceCommandSchema.safeParse({
    method: "project/tree/refresh", params: {}, scope,
  }).success, false);
});
