/* No production exports. Regression wards cover visible transcript proposal intent indexing and editable message ownership. */

import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import getThreadGitArcProposalIntents, {
  proposalIntentOwnsMessage,
} from "./thread-git-arc-proposal-intents";

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
    pluginId: null,
    processId: null,
    scriptPath: null,
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
        "wb git arc propose --amend --title \"Preview hoisted proposal\" --description \"Show both fields immediately.\" --fresh-title \"Commit correction separately\" --fresh-description \"Keep prior history unchanged.\" -- src/one.ts",
        "Workbench arc proposal: proposal-one\n",
      ),
    ])],
  });

  assert.deepEqual(intents.get("proposal-one"), {
    amend: true,
    description: "Show both fields immediately.",
    freshDescription: "Keep prior history unchanged.",
    freshTitle: "Commit correction separately",
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
        "wb git arc propose --title \"Earlier title\"",
        "Workbench arc proposal: shared-proposal\n",
      )]),
      turn("turn-two", [commandItem(
        "proposal-two",
        "wb git arc propose --title \"Later title\" --description \"Latest visible description\"",
        "Workbench arc proposal: shared-proposal\n",
      )]),
    ],
  });

  assert.equal(intents.get("shared-proposal")?.title, "Later title");
  assert.equal(intents.get("shared-proposal")?.description, "Latest visible description");
});

test("visible proposal intents resolve a preceding literal PowerShell here-string", () => {
  const description = "- preserve proposal claims\n- retry the same Commit action";
  const command = String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "$description = @'
${description}
'@
wb git arc propose --replace proposal-one --title \"keep proposal recovery ordinary\" --description $description"`;
  const intents = getThreadGitArcProposalIntents({
    projectRootPath: "C:/workspace",
    turns: [turn("turn-one", [commandItem(
      "proposal",
      command,
      "Workbench arc proposal: proposal-one\n",
    )])],
  });

  assert.deepEqual(intents.get("proposal-one"), {
    amend: false,
    description,
    paths: [],
    title: "keep proposal recovery ordinary",
  });
});

test("only proposal intent with an explicit title owns the editable message", () => {
  assert.equal(proposalIntentOwnsMessage({
    amend: true,
    description: "Ignored without a replacement title",
    paths: [],
    title: "",
  }), false);
  assert.equal(proposalIntentOwnsMessage({
    amend: true,
    description: "",
    paths: [],
    title: "Replacement title",
  }), true);
  assert.equal(proposalIntentOwnsMessage({
    amend: false,
    description: "",
    paths: [],
    title: "New commit title",
  }), true);
});

test("MCP amend proposal intents preserve both user-selectable messages", () => {
  const item: Extract<ThreadItem, { type: "mcpToolCall" }> = {
    appContext: null,
    arguments: {
      amend: true,
      description: "Rewrite the accepted message.",
      freshDescription: "Keep accepted history intact.",
      freshTitle: "Add the correction",
      paths: ["src/one.ts"],
      title: "Amend the correction",
    },
    durationMs: 10,
    error: null,
    id: "proposal-mcp",
    pluginId: null,
    readOnlyHint: false,
    result: {
      _meta: null,
      content: [{ type: "text", text: "Workbench arc proposal: proposal-mcp\n" }],
      structuredContent: null,
    },
    server: "wb",
    status: "completed",
    tool: "git_arc_propose",
    type: "mcpToolCall",
  };
  const intents = getThreadGitArcProposalIntents({ turns: [turn("turn-one", [item])] });
  assert.deepEqual(intents.get("proposal-mcp"), {
    amend: true,
    description: "Rewrite the accepted message.",
    freshDescription: "Keep accepted history intact.",
    freshTitle: "Add the correction",
    paths: ["src/one.ts"],
    title: "Amend the correction",
  });
});
