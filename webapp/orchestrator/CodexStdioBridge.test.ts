/*
 * Exports:
 * - No production exports; Node tests cover bridge send-throw pending cleanup and transcript ordering. Keywords: codex, bridge, transcript, test.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type CodexAppServer from "./CodexAppServer";
import CodexStdioBridge from "./CodexStdioBridge";
import type { BridgeClient } from "./bridge-types";

test("external socket send failure clears pending response and records exact steer failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-test-"));
  const client: BridgeClient = {
    OPEN: 1,
    close() {},
    on() {},
    once() {},
    readyState: 1,
    send() {},
  };
  const appServer = {
    send() {
      throw new Error("upstream socket failed Bearer secret-token at C:\\Users\\private\\thread.json");
    },
  } as unknown as CodexAppServer;
  const bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient() {},
    storageRoot: root,
  });
  try {
    await assert.rejects(bridge.forwardRequest({
      id: 7,
      method: "turn/steer",
      params: {
        clientUserMessageId: "native",
        expectedTurnId: "turn",
        input: [{ text: "one", text_elements: [], type: "text" }],
        threadId: "thread",
      },
    }, client, 7), /upstream socket failed/u);
    const state = await bridge.detachForReload();
    assert.equal(state.pendingResponses.size, 0);
    const transcriptPath = path.join(root, ".workbench", "transcripts", "codex", "threads");
    const threadDirectories = await fs.readdir(transcriptPath);
    assert.equal(threadDirectories.length, 1);
    const persisted = JSON.parse(await fs.readFile(path.join(transcriptPath, threadDirectories[0]!, "thread.json"), "utf8")) as {
      steerEntries?: Array<{ clientUserMessageId?: string | null; error: string | null; status: string }>;
    };
    assert.deepEqual(persisted.steerEntries?.map((entry) => [entry.clientUserMessageId, entry.status]), [["native", "failed"]]);
    assert.doesNotMatch(persisted.steerEntries?.[0]?.error ?? "", /secret-token|Users\\private/u);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("successful external send remaps the response id and detaches with settled reload state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-bridge-success-test-"));
  const client: BridgeClient = {
    OPEN: 1, close() {}, on() {}, once() {}, readyState: 1, send() {},
  };
  let upstreamRequest: { id: number; method: string } | null = null;
  const appServer = {
    send(message: unknown) {
      upstreamRequest = message as { id: number; method: string };
    },
  } as unknown as CodexAppServer;
  const clientMessages: unknown[] = [];
  const bridge = new CodexStdioBridge({
    appServer,
    bridgeUrl: "ws://127.0.0.1:1",
    onNotification() {},
    resolveProjectFromCwd: async () => null,
    sendToClient(_client, message) { clientMessages.push(message); },
    storageRoot: root,
  });
  try {
    await bridge.forwardRequest({
      id: 41,
      method: "turn/steer",
      params: {
        clientUserMessageId: "native", expectedTurnId: "turn",
        input: [{ text: "one", text_elements: [], type: "text" }], threadId: "thread",
      },
    }, client, 41);
    assert.equal(upstreamRequest?.method, "turn/steer");
    await bridge.handleUpstreamMessage({ id: upstreamRequest!.id, result: { turnId: "turn" } });
    assert.deepEqual(clientMessages, [{ id: 41, result: { turnId: "turn" } }]);
    const state = await bridge.detachForReload();
    assert.equal(state.pendingResponses.size, 0);
    assert.ok(state.requestIdAllocator.next > upstreamRequest!.id);
  } finally {
    await bridge.disposeImmediately();
    await fs.rm(root, { force: true, recursive: true });
  }
});
