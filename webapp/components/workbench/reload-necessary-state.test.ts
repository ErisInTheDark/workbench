/*
 * No production exports. Tests protect destructive reload confirmation duration. Keywords: reload, hold, destructive, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DESTRUCTIVE_RELOAD_HOLD_MS,
  getReloadAllHoldMs,
  getReloadScopeHoldMs,
  NORMAL_RELOAD_HOLD_MS,
} from "./reload-necessary-state";

const regular = { description: "Core", destructive: false, scope: "server:core" } as const;
const destructive = { description: "Codex harness", destructive: true, scope: "harness:codex" } as const;

test("destructive scopes require the long hold and reload all uses the longest hold", () => {
  assert.equal(getReloadScopeHoldMs(regular), NORMAL_RELOAD_HOLD_MS);
  assert.equal(getReloadScopeHoldMs(destructive), DESTRUCTIVE_RELOAD_HOLD_MS);
  assert.equal(getReloadAllHoldMs([regular]), NORMAL_RELOAD_HOLD_MS);
  assert.equal(getReloadAllHoldMs([regular, destructive]), DESTRUCTIVE_RELOAD_HOLD_MS);
});
