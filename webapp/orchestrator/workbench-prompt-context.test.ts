/*
 * Exports:
 * - No production exports; tests prove caller prompt context cannot select trusted transport axes. Keywords: prompt, context, harness, trust.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readWorkbenchPromptContext, WORKBENCH_PROMPT_CONTEXT_FIELD } from "./workbench-prompt-context";

test("parses caller-owned selections but discards an untrusted harness selector", () => {
  const context = readWorkbenchPromptContext({
    id: 1,
    method: "turn/start",
    [WORKBENCH_PROMPT_CONTEXT_FIELD]: {
      agentPath: "agent://default.md",
      harness: "copilot",
      instructionScope: "threadUtilities",
      projectId: "web/workbench",
      threadId: "thread-1",
      workflowIds: ["subagent"],
    },
  });
  assert.equal(context?.agentPath, "agent://default.md");
  assert.equal(context?.instructionScope, "threadUtilities");
  assert.equal(context?.harness, undefined);
  assert.deepEqual(context?.workflowIds, ["subagent"]);
});
