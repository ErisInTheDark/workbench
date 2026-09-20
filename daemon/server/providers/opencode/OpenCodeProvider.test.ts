/*
 * Exports:
 * - tests: provider registration is exercised through graph tests rather than source-shape assertions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import providerRegistrations from "workbench-shared/workbench/provider/provider-registrations";

test("installs OpenCode under its graph provider registration", () => {
  assert.equal(providerRegistrations.opencode, "openCodeProvider");
});
