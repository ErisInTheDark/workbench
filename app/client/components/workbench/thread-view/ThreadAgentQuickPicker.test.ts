/* No production exports. Tests protect quick agent choice identity and canonical selection matching. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchAgentOption } from "workbench-shared/types";
import { getThreadAgentQuickChoices } from "./ThreadAgentQuickPicker";

test("quick agent choices preserve catalogue identity and canonically mark the current agent", () => {
  const agents: WorkbenchAgentOption[] = [
    {
      name: "Reviewer",
      description: "Reviews changes.",
      path: ".agents/agents/reviewer.md",
      source: "project",
      sourceLabel: "Project",
    },
    {
      name: "Researcher",
      description: "Researches unfamiliar systems.",
      path: "library:agents/researcher.md",
      source: "library",
      sourceLabel: "Workbench library",
    },
  ];

  const choices = getThreadAgentQuickChoices(agents, ".agents\\agents\\reviewer.md");

  assert.deepEqual(choices.map(({ agentPath, agentSource, checked }) => ({
    agentPath, agentSource, checked,
  })), [
    { agentPath: null, agentSource: null, checked: false },
    { agentPath: ".agents/agents/reviewer.md", agentSource: "project", checked: true },
    { agentPath: "library:agents/researcher.md", agentSource: "library", checked: false },
  ]);
});
