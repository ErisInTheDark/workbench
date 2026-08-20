/* No production exports. Regression wards cover visible transcript proposal intent indexing. */

import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../../../lib/codex/generated/app-server/v2/Turn";
import getThreadGitArcProposalIntents from "./thread-git-arc-proposal-intents";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;

function commandItem(id: string, command: string, aggregatedOutput: string | null): CommandItem {
  return {
    aggregatedOutput,
    command,
    commandActions: [],
    cwd: "C:/workspace",
    durationMs: 10,
    exitCode: 0,
    id,
    processId: null,
    source: "agent",
    status: "completed",
    type: "commandExecution",
  };
}

function turn(id: string, items: ThreadItem[]): Turn {
  return {
    completedAt: null,
    durationMs: 10,
    error: null,
    id,
    items,
    itemsView: "full",
    startedAt: null,
    status: "completed",
  };
}

test("visible proposal intents associate title and description with the proposal receipt", () => {
  const intents = getThreadGitArcProposalIntents({
    projectRootPath: "C:/workspace",
    turns: [turn("turn-one", [
      commandItem("ordinary", "pnpm typecheck", null),
      commandItem(
        "proposal",
        "wb git arc propose -m \"Preview hoisted proposal\" -m \"Show both messages immediately.\" -- src/one.ts",
        "Workbench arc proposal: proposal-one\n",
      ),
    ])],
  });

  assert.deepEqual(intents.get("proposal-one"), {
    amend: false,
    description: "Show both messages immediately.",
    paths: ["src/one.ts"],
    title: "Preview hoisted proposal",
  });
  assert.equal(intents.size, 1);
});

test("later loaded transcript entries replace an earlier intent for the same proposal", () => {
  const intents = getThreadGitArcProposalIntents({
    turns: [
      turn("turn-one", [commandItem(
        "proposal-one",
        "wb git arc propose -m \"Earlier title\"",
        "Workbench arc proposal: shared-proposal\n",
      )]),
      turn("turn-two", [commandItem(
        "proposal-two",
        "wb git arc propose -m \"Later title\" -m \"Latest visible description\"",
        "Workbench arc proposal: shared-proposal\n",
      )]),
    ],
  });

  assert.equal(intents.get("shared-proposal")?.title, "Later title");
  assert.equal(intents.get("shared-proposal")?.description, "Latest visible description");
});
