/*
 * Exports:
 * - No production exports; tests protect native adaptation and compatibility location exports.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isProjectCodexThreadAtExpectedCwd, toThreadTurn } from "./thread-adapter.ts";
import { getWorkbenchInputState, withWorkbenchInputState } from "../workbench/thread/thread-input-item.ts";
import type { Turn } from "./generated/app-server/v2/Turn.ts";

test("relationship-owned cwd permits an exact linked-worktree thread without broadening project membership", () => {
  const projectRoot = "C:/git/web/workbench";
  const linkedWorktree = "C:/git/web/workbench/.workbench/worktrees/convex-lab";

  assert.equal(isProjectCodexThreadAtExpectedCwd({ cwd: linkedWorktree }, projectRoot, null), false);
  assert.equal(isProjectCodexThreadAtExpectedCwd({ cwd: linkedWorktree }, projectRoot, linkedWorktree), true);
  assert.equal(isProjectCodexThreadAtExpectedCwd({ cwd: `${linkedWorktree}/nested` }, projectRoot, linkedWorktree), false);
  assert.equal(isProjectCodexThreadAtExpectedCwd({ cwd: "C:/git/web/other" }, projectRoot, "C:/git/web/other"), false);
  assert.equal(isProjectCodexThreadAtExpectedCwd(
    { cwd: "c:\\git\\web\\workbench\\.workbench\\worktrees\\convex-lab" },
    projectRoot,
    linkedWorktree,
  ), true);
});

test("native turn adaptation converts old steer state while preserving explicit state", () => {
  for (const status of ["pending", "failed", "interrupted", "sent"] as const) {
    const legacy = {
      clientId: null, content: [], id: `workbench:steer-history:${status}:thread:request`, type: "userMessage" as const,
    };
    const turn: Turn = { id: "turn", items: [legacy], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null };
    assert.deepEqual(getWorkbenchInputState(toThreadTurn(turn).items[0]!), { kind: "steer", status });
    turn.items = [withWorkbenchInputState(legacy, { kind: "steer", status: "sent" })];
    assert.deepEqual(getWorkbenchInputState(toThreadTurn(turn).items[0]!), { kind: "steer", status: "sent" });
  }
});

test("native adaptation rejects file-backed user and tool images without exposing their references", () => {
  const reference = "private-provider-file-reference";
  const items: Turn["items"] = [
    { type: "userMessage", id: "input", clientId: null, content: [
      { type: "text", text: "retain this text", text_elements: [] },
      { type: "image", fileId: reference },
    ] },
    { type: "functionCallOutput", id: "output", name: "capture", namespace: null, output: [
      { type: "input_text", text: "retain this output" },
      { type: "input_image", file_id: reference },
    ] },
  ];
  for (const item of items) {
    const turn: Turn = {
      id: "turn", items: [item], itemsView: "full", status: "completed",
      error: null, startedAt: null, completedAt: null, durationMs: null,
    };
    assert.throws(() => toThreadTurn(turn), error => (
      error instanceof Error && !error.message.includes(reference)
    ));
    assert.equal(turn.items[0], item);
  }
});

test("native adaptation preserves supported images, surrounding content and detail", () => {
  const turn: Turn = {
    id: "turn", itemsView: "full", status: "completed",
    error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
    items: [
      { type: "userMessage", id: "input", clientId: "client", content: [
        { type: "text", text: "look here", text_elements: [] },
        { type: "image", url: "data:image/png;base64,image", detail: "original" },
        { type: "localImage", path: "/image.png", detail: "high" },
      ] },
      { type: "functionCallOutput", id: "output", name: "capture", namespace: null, output: [
        { type: "input_text", text: "captured context" },
        { type: "input_image", image_url: "/image.png", detail: "original" },
      ] },
    ],
  };
  const adapted = toThreadTurn(turn);
  assert.deepEqual(adapted.items, turn.items);
  assert.equal(adapted.id, turn.id);
  assert.equal(adapted.durationMs, turn.durationMs);
});
