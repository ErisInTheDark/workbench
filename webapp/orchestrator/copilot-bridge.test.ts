/*
 * Exports:
 * - No production exports; tests protect Copilot instruction filtering and harness-neutral thread-page translation. Keywords: copilot, instructions, filter, thread, page.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import { CopilotBridge } from "./copilot-bridge";
import type { OrchestratorReloadableModules } from "./orchestrator-runtime-objects";

function thread(): Thread {
  return {
    agentNickname: null, agentRole: null, canAcceptDirectInput: null, cliVersion: "test", createdAt: 1, cwd: "C:/repo", ephemeral: false,
    extra: null, forkedFromId: null, gitInfo: null, historyMode: "legacy", id: "thread", modelProvider: "copilot", name: null,
    parentThreadId: null, path: null, preview: "", recencyAt: null, section: null, sectionEnteredAt: null, sessionId: "session",
    source: "appServer", status: { type: "idle" }, threadSource: null, turns: [], updatedAt: 1,
  };
}

test("filters the final joined Copilot system message with bridge-owned selectors", async () => {
  const source = await readFile(path.join(__dirname, "copilot-bridge.ts"), "utf8");
  const joinIndex = source.indexOf("const content = joinSystemMessageSections");
  const filterIndex = source.indexOf("filterWorkbenchInstructionContent(content", joinIndex);
  assert.ok(joinIndex >= 0);
  assert.ok(filterIndex > joinIndex);
  assert.match(source.slice(filterIndex, filterIndex + 500), /harness: "copilot"/u);
  assert.match(source.slice(filterIndex, filterIndex + 500), /shell: process\.platform/u);
});

test("maps the Workbench first page to the existing Copilot thread read and rejects continuation", async () => {
  const bridge = new CopilotBridge({
    getReloadableModules: () => ({}) as OrchestratorReloadableModules,
    onNotification() {},
    projectRoot: "C:/repo",
  });
  const pageOwner = bridge as unknown as {
    readThread(
      threadId: string,
      model: string | null,
      reasoningEffort: string | null,
      agentPath: string | null,
      workbenchOrigin: string | null,
      projectId: string | null,
      promptContext: null,
    ): Promise<{ model: string; modelProvider: string; reasoningEffort: null; thread: Thread }>;
  };
  pageOwner.readThread = async (threadId, model, reasoningEffort, agentPath, workbenchOrigin, projectId, promptContext) => {
    assert.deepEqual(
      { agentPath, model, projectId, promptContext, reasoningEffort, threadId, workbenchOrigin },
      { agentPath: null, model: null, projectId: null, promptContext: null, reasoningEffort: null, threadId: "thread", workbenchOrigin: null },
    );
    return { model: "copilot-model", modelProvider: "copilot", reasoningEffort: null, thread: thread() };
  };

  const first = await bridge.handleRequest({
    id: 1,
    method: "workbench/thread/page/read",
    params: { cursor: null, threadId: "thread" },
  });
  assert.deepEqual(first.result, {
    browseResultEntries: [],
    model: "copilot-model",
    nextCursor: null,
    questionnaireEntries: [],
    reasoningEffort: null,
    serviceTier: null,
    steerEntries: [],
    thread: thread(),
  });

  const continuation = await bridge.handleRequest({
    id: 2,
    method: "workbench/thread/page/read",
    params: { cursor: "turn", threadId: "thread" },
  });
  assert.match(continuation.error?.message ?? "", /do not have a continuation cursor/u);
});
