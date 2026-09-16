/*
 * Exports:
 * - No production exports; tests protect agent duplication and skill instruction assembly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchAgentSkillCatalogController from "./WorkbenchAgentSkillCatalogController.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

test("catalog delegates source reads and excludes globally installed instruction-pack bodies", async () => {
  const agent = { description: "Lily", name: "Lily", path: "agents/lily.md", prompt: "LILY PREFIX" };
  const projectSkill = {
    content: "PROJECT SKILL",
    description: "Project skill",
    name: "project",
    path: "C:/repo/.agents/skills/project/SKILL.md",
    relativePath: ".agents/skills/project/SKILL.md",
  };
  const instructionPacks = [
    { content: "GLOBAL PACK", name: "global", path: "global.md" },
    { content: "LOCAL PACK", name: "local", path: "local.md" },
  ];
  let bootstrapOptions: { skipInstructionPackContents?: readonly string[] } | undefined;
  const project = {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    kind: "git" as const,
    root: "C:/repo",
    rootPath: "C:/repo",
    roots: [{ id: "repo", name: "repo", root: "C:/repo", rootPath: "C:/repo" }],
  };
  const resolvedProjectIds: string[] = [];
  const projectRoots: string[] = [];
  const controller = new WorkbenchAgentSkillCatalogController(async (projectId) => {
    resolvedProjectIds.push(projectId);
    return project;
  }, async sections => sections.map(text => ["LILY PREFIX", "GLOBAL PACK"].includes(text)), {
    buildBootstrap: async (_skills, options) => {
      bootstrapOptions = options;
      return "assembled";
    },
    listActiveSkills: async (skills) => [...skills],
    listInstructionPacks: async () => instructionPacks,
    listProjectSkills: async (root) => { projectRoots.push(root); return [projectSkill]; },
    listUserAgents: async (resolvedProject) => { projectRoots.push(resolvedProject.root); return [agent]; },
    readAgent: async (_agentPath, root) => { projectRoots.push(root); return agent; },
  });

  assert.deepEqual(await controller.listAgents("project"), { data: [agent] });
  assert.deepEqual(await controller.readAgent("project", agent.path), {
    codexGlobalDuplicate: true,
    data: agent,
  });
  assert.deepEqual(await controller.readSkills("project"), {
    data: [{
      description: projectSkill.description,
      name: projectSkill.name,
      path: projectSkill.path,
      relativePath: projectSkill.relativePath,
    }],
    instructionPacks,
    instructions: "assembled",
  });
  assert.deepEqual(bootstrapOptions?.skipInstructionPackContents, ["GLOBAL PACK"]);
  assert.deepEqual(resolvedProjectIds, ["project", "project", "project"]);
  assert.deepEqual(projectRoots, ["C:/repo", "C:/repo", "C:/repo"]);
});
