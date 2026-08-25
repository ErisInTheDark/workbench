/* No production exports. Tests protect Codex apply_patch hook parsing and fail-closed decision output. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  allowCodexApplyPatch,
  denyCodexApplyPatch,
  parseCodexApplyPatchClaimHook,
} from "./codex-apply-patch-claim-hook";
import { createWorkbenchFileChangeFailureSystemMessage } from "./thread/workbench-file-change";

function hookInput(command: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    cwd: path.resolve("C:/workspace"),
    session_id: "thread-one",
    tool_use_id: "patch-one",
    tool_input: { command },
    tool_name: "apply_patch",
    turn_id: "turn-one",
    ...overrides,
  });
}

test("extracts every add, delete, update, and move path from one patch", () => {
  const cwd = path.resolve("C:/workspace");
  assert.deepEqual(parseCodexApplyPatchClaimHook(hookInput(`*** Begin Patch
*** Add File: src/added.ts
+new
+another
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
+extra
*** End Patch`)), {
    changes: [
      { additions: 2, deletions: 0, kind: { type: "add" }, path: path.resolve(cwd, "src/added.ts") },
      { additions: 0, deletions: 0, kind: { type: "delete" }, path: path.resolve(cwd, "src/deleted.ts") },
      { additions: 1, deletions: 1, kind: { move_path: path.resolve(cwd, "src/renamed.ts"), type: "update" }, path: path.resolve(cwd, "src/moved.ts") },
      { additions: 2, deletions: 1, kind: { move_path: null, type: "update" }, path: path.resolve(cwd, "src/kept.ts") },
    ],
    cwd,
    paths: ["src/added.ts", "src/deleted.ts", "src/moved.ts", "src/renamed.ts", "src/kept.ts"].map((filePath) => path.resolve(cwd, filePath)),
    sessionId: "thread-one",
    toolUseId: "patch-one",
    turnId: "turn-one",
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
  assert.deepEqual(parsed.changes, [{
    additions: 2,
    deletions: 2,
    kind: { move_path: path.resolve(parsed.cwd, "src/destination.ts"), type: "update" },
    path: path.resolve(parsed.cwd, "src/repeated.ts"),
  }]);
});

test("rejects malformed input, unsupported tools, empty patches, and orphan moves", () => {
  assert.throws(() => parseCodexApplyPatchClaimHook("not json"), /not valid JSON/u);
  assert.throws(() => parseCodexApplyPatchClaimHook(hookInput("*** Begin Patch\n*** End Patch", { tool_name: "shell_command" })), /only accepts apply_patch/u);
  assert.throws(() => parseCodexApplyPatchClaimHook(hookInput("*** Begin Patch\n*** End Patch")), /no supported file paths/u);
  assert.throws(() => parseCodexApplyPatchClaimHook(hookInput("*** Begin Patch\n*** Move to: src/orphan.ts\n*** End Patch")), /no Update File source/u);
  assert.throws(() => parseCodexApplyPatchClaimHook(hookInput("*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch", { tool_use_id: "" })), /tool_use_id is required/u);
  assert.throws(() => parseCodexApplyPatchClaimHook(hookInput("*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch", { turn_id: "" })), /turn_id is required/u);
});

test("emits Codex-compatible allow and bounded sanitized deny decisions", () => {
  assert.deepEqual(allowCodexApplyPatch(), {});
  const decision = denyCodexApplyPatch(`missing\nclaim ${"x".repeat(700)}`);
  assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(decision.hookSpecificOutput.permissionDecisionReason?.includes("\n"), false);
  assert.equal(decision.hookSpecificOutput.permissionDecisionReason?.length, 500);
  assert.equal(decision.systemMessage, undefined);

  const metadataDecision = denyCodexApplyPatch("missing claim", "workbench:file-change-failure:v1:{}");
  assert.equal(metadataDecision.systemMessage, "workbench:file-change-failure:v1:{}");
  assert.equal("additionalContext" in metadataDecision, false);
});

test("bounds Workbench file-change metadata without weakening denial output", () => {
  const summary = {
    additions: 1,
    deletions: 0,
    kind: { type: "add" as const },
    path: "src/a.ts",
  };
  assert.match(createWorkbenchFileChangeFailureSystemMessage([summary]) ?? "", /^workbench:file-change-failure:v1:/u);
  assert.equal(createWorkbenchFileChangeFailureSystemMessage([{ ...summary, path: "x".repeat(65_536) }]), null);
  assert.equal(denyCodexApplyPatch("missing claim", undefined).hookSpecificOutput.permissionDecision, "deny");
});
