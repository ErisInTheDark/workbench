/* No production exports. Tests protect Codex apply_patch hook parsing and fail-closed decision output. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  allowCodexApplyPatch,
  denyCodexApplyPatch,
  parseCodexApplyPatchClaimHook,
} from "./codex-apply-patch-claim-hook";

function hookInput(command: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    cwd: path.resolve("C:/workspace"),
    session_id: "thread-one",
    tool_input: { command },
    tool_name: "apply_patch",
    ...overrides,
  });
}

test("extracts every add, delete, update, and move path from one patch", () => {
  const cwd = path.resolve("C:/workspace");
  assert.deepEqual(parseCodexApplyPatchClaimHook(hookInput(`*** Begin Patch
*** Add File: src/added.ts
+new
*** Delete File: src/deleted.ts
*** Update File: src/moved.ts
*** Move to: src/renamed.ts
@@
-old
+new
*** Update File: src/kept.ts
@@
-old
+new
*** End Patch`)), {
    cwd,
    paths: ["src/added.ts", "src/deleted.ts", "src/moved.ts", "src/renamed.ts", "src/kept.ts"].map((filePath) => path.resolve(cwd, filePath)),
    sessionId: "thread-one",
  });
});

test("deduplicates paths without hiding an uncovered move destination", () => {
  const parsed = parseCodexApplyPatchClaimHook(hookInput(`*** Begin Patch
*** Update File: src/repeated.ts
@@
-old
+new
*** Update File: src/repeated.ts
*** Move to: src/destination.ts
@@
-old
+new
*** End Patch`));
  assert.deepEqual(parsed.paths, ["src/repeated.ts", "src/destination.ts"].map((filePath) => path.resolve(parsed.cwd, filePath)));
});

test("rejects malformed input, unsupported tools, empty patches, and orphan moves", () => {
  assert.throws(() => parseCodexApplyPatchClaimHook("not json"), /not valid JSON/u);
  assert.throws(() => parseCodexApplyPatchClaimHook(hookInput("*** Begin Patch\n*** End Patch", { tool_name: "shell_command" })), /only accepts apply_patch/u);
  assert.throws(() => parseCodexApplyPatchClaimHook(hookInput("*** Begin Patch\n*** End Patch")), /no supported file paths/u);
  assert.throws(() => parseCodexApplyPatchClaimHook(hookInput("*** Begin Patch\n*** Move to: src/orphan.ts\n*** End Patch")), /no Update File source/u);
});

test("emits Codex-compatible allow and bounded sanitized deny decisions", () => {
  assert.deepEqual(allowCodexApplyPatch(), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  });
  const decision = denyCodexApplyPatch(`missing\nclaim ${"x".repeat(700)}`);
  assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(decision.hookSpecificOutput.permissionDecisionReason?.includes("\n"), false);
  assert.equal(decision.hookSpecificOutput.permissionDecisionReason?.length, 500);
});
