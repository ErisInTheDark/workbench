/*
 * Exports:
 * - tests: protect managed OpenCode metadata, permissions, and fresh instruction entries.
 */
import assert from "node:assert/strict";
import test from "node:test";
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
  await controller.refresh(context);
  await controller.refresh(context);
  assert.deepEqual(updates, [
    {
      sessionID: "session",
      permissions: [
        { action: "bash", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "deny" },
      ],
    },
    {
      sessionID: "session",
      permissions: [
        { action: "bash", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "deny" },
      ],
    },
  ]);
  assert.deepEqual(operations, ["permissions", "instructions", "permissions", "instructions"]);
  assert.deepEqual(puts, [
    {
      sessionID: "session",
      key: "workbench",
      value: "base-1-opencode\n\ndeveloper-opencode/model\n\nC:/skills/one/SKILL.md",
    },
    {
      sessionID: "session",
      key: "workbench",
      value: "base-2-opencode\n\ndeveloper-opencode/model\n\nC:/skills/one/SKILL.md",
    },
  ]);
});
