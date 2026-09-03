/*
 * No production exports. Tests protect harness-neutral OpenCode thread-page translation. Keywords: opencode, thread, page, cursor.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import { OpenCodeBridge } from "./opencode-bridge";
import type OpenCodeAppServer from "./OpenCodeAppServer";
import type { OrchestratorReloadableModules } from "./orchestrator-runtime-objects";

function thread(): Thread {
  return {
    agentNickname: null, agentRole: null, canAcceptDirectInput: null, cliVersion: "test", createdAt: 1, cwd: "C:/repo", ephemeral: false,
    extra: null, forkedFromId: null, gitInfo: null, historyMode: "legacy", id: "thread", modelProvider: "opencode", name: null,
    parentThreadId: null, path: null, preview: "", recencyAt: null, section: null, sectionEnteredAt: null, sessionId: "session",
    source: "appServer", status: { type: "idle" }, threadSource: null, turns: [], updatedAt: 1,
  };
}

test("maps the Workbench first page to the existing OpenCode thread read and rejects continuation", async () => {
  const bridge = new OpenCodeBridge({
    appServer: {} as OpenCodeAppServer,
    getReloadableModules: () => ({
      opencodeLiveThreadState: {
        createOpenCodeLiveThreadState: () => ({ sessions: new Map() }),
      },
    }) as OrchestratorReloadableModules,
    onNotification() {},
    projectRoot: "C:/repo",
  });
  const pageOwner = bridge as unknown as {
    readThread(threadId: string, directory: string): Promise<{
      model: string;
      modelProvider: string;
      reasoningEffort: string;
      serviceTier: null;
      thread: Thread;
    }>;
  };
  pageOwner.readThread = async (threadId, directory) => {
    assert.deepEqual({ directory, threadId }, { directory: "C:/chosen", threadId: "thread" });
    return {
      model: "opencode-model",
      modelProvider: "opencode",
      reasoningEffort: "high",
      serviceTier: null,
      thread: thread(),
    };
  };

  const first = await bridge.handleRequest({
    id: 1,
    method: "workbench/thread/page/read",
    params: { cursor: null, cwd: "C:/chosen", threadId: "thread" },
  });
  assert.deepEqual(first.result, {
    browseResultEntries: [],
    model: "opencode-model",
    nextCursor: null,
    questionnaireEntries: [],
    reasoningEffort: "high",
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
