/*
 * Exports:
 * - tests: protect managed OpenCode metadata, parent-only and root-only permissions, fresh instruction entries, and prompt-bound activated skills.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_PARENT_ONLY_TOOLS } from "workbench-shared/workbench/commands/workbench-tool-audience";
import { listWorkbenchAgentCommands } from "../../lib/workbench/commands/workbench-agent-command-registry";
import { listWorkbenchInstructionTools } from "../../lib/workbench/instructions/instruction-tool-reference";
import OpenCodeManagedSessionController from "./OpenCodeManagedSessionController";

test("marks managed sessions and refreshes filtered instructions before each prompt", async () => {
  const puts: object[] = [];
  const updates: object[] = [];
  const operations: string[] = [];
  let generation = 0;
  const controller = new OpenCodeManagedSessionController({
    acquire: async () => ({
      session: {
        update: async (input: object) => {
          updates.push(input);
          operations.push("permissions");
        },
        instructions: {
          entry: {
            put: async (input: object) => {
              puts.push(input);
              operations.push("instructions");
            },
          },
        },
      },
    } as never),
    build: async context => ({
      baseInstructions: `base-${++generation}-${context.harness}`,
      developerInstructions: `developer-${context.model}`,
      activatedSkills: context.activatedSkillPaths?.join(",") ?? null,
    }),
    readInstructionTools: async () => [],
    readLocalCapabilities: async () => ({ browseRawCommandsEnabled: false }),
    workbenchRoot: "C:/project",
  });

  assert.deepEqual(controller.creation(), {
    metadata: { workbench: { managed: true, provider: "opencode", version: 1 } },
    permissions: [
      { action: "bash", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ],
  });

  const context = {
    sessionID: "session",
    cwd: "C:/project",
    projectId: "project",
    threadId: "thread",
    model: "opencode/model",
    agentPath: null,
    workflowIds: ["default"],
    activatedSkillPaths: ["C:/skills/one/SKILL.md"],
  };
  const first = await controller.refresh(context);
  await controller.refresh(context);
  await controller.refresh({ ...context, subagentName: "mira" });
  // Skill bodies belong in the prompt, not in instructions the next refresh replaces.
  assert.deepEqual(first, { activatedSkills: "C:/skills/one/SKILL.md" });
  assert.deepEqual((updates[0] as { permissions: object[] }).permissions, controller.creation().permissions);
  assert.deepEqual((updates[1] as { permissions: object[] }).permissions, controller.creation().permissions);
  assert.deepEqual((updates[2] as { permissions: object[] }).permissions, [
    ...controller.creation().permissions,
    ...WORKBENCH_PARENT_ONLY_TOOLS.flatMap(id => ["wb", "wbex"].map(namespace => ({ action: `${namespace}_${id}`, resource: "*", effect: "deny" }))),
  ]);
  assert.deepEqual(operations, ["permissions", "instructions", "permissions", "instructions", "permissions", "instructions"]);
  assert.deepEqual(puts, [
    {
      sessionID: "session",
      key: "workbench",
      value: "base-1-opencode\n\ndeveloper-opencode/model",
    },
    {
      sessionID: "session",
      key: "workbench",
      value: "base-2-opencode\n\ndeveloper-opencode/model",
    },
    {
      sessionID: "session",
      key: "workbench",
      value: "base-3-opencode\n\ndeveloper-opencode/model",
    },
  ]);
});

test("sessions outside the Workbench repository root are denied its root-only tools", async () => {
  const updates: Array<{ permissions: Array<{ action: string }> }> = [];
  const controller = new OpenCodeManagedSessionController({
    acquire: async () => ({
      session: {
        update: async (input: { permissions: Array<{ action: string }> }) => { updates.push(input); },
        instructions: { entry: { put: async () => undefined } },
      },
    } as never),
    build: async () => ({ baseInstructions: null, developerInstructions: null, activatedSkills: null }),
    readInstructionTools: async () => listWorkbenchInstructionTools(listWorkbenchAgentCommands()),
    readLocalCapabilities: async () => ({ browseRawCommandsEnabled: false }),
    workbenchRoot: "C:/workbench",
  });
  const context = {
    sessionID: "session", projectId: "project", threadId: "thread", model: null, agentPath: null,
    workflowIds: [], activatedSkillPaths: [],
  };
  await controller.refresh({ ...context, cwd: "C:/elsewhere" });
  await controller.refresh({ ...context, cwd: "C:/workbench" });
  const denied = updates.map(({ permissions }) => new Set(permissions.map(({ action }) => action)));
  for (const action of ["wb_tokens_instructions", "wbex_tokens_instructions"]) {
    assert.equal(denied[0]!.has(action), true, `${action} should be denied outside the root`);
    assert.equal(denied[1]!.has(action), false, `${action} should stay available at the root`);
  }
});
