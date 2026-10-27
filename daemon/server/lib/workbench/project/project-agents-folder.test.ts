/*
 * No production exports. Tests protect the gitignored `.agents.local` overlay: local skills and agents replace
 * same-named `.agents` ones, and tombstones hide a name at every skill layer and from project agents.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

async function write(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function createFixture(context: { after: (callback: () => Promise<void>) => void }) {
  const temporary = await WorkbenchTemporaryDirectory.create("project-agents-folder-");
  const previousLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;
  context.after(async () => {
    if (previousLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
    else process.env.WORKBENCH_LIBRARY_ROOT = previousLibraryRoot;
    await temporary.dispose();
  });
  process.env.WORKBENCH_LIBRARY_ROOT = path.join(temporary.path, "library");
  return {
    home: path.join(temporary.path, "home"),
    library: process.env.WORKBENCH_LIBRARY_ROOT,
    project: path.join(temporary.path, "project"),
  };
}

test("local skills replace project skills and tombstones hide a skill from every layer", async (context) => {
  const roots = await createFixture(context);
  const { listProjectSkillsFromRoot } = await import("./project-agents-folder");
  const { listActiveWorkbenchSkillDefinitions } = await import("../../workbench-library");
  await Promise.all([
    write(roots.project, ".agents/skills/shared/SKILL.md", "---\nname: shared\n---\nproject shared\n"),
    write(roots.project, ".agents.local/skills/shared/SKILL.md", "---\nname: renamed\n---\nlocal shared\n"),
    write(roots.project, ".agents/skills/kept/SKILL.md", "---\nname: kept\n---\nproject kept\n"),
    write(roots.project, ".agents.local/skills/Gone.tombstone", ""),
    write(roots.project, ".agents.local/skills/gone/SKILL.md", "---\nname: gone\n---\nlocal gone\n"),
    write(roots.project, ".agents/skills/gone/SKILL.md", "---\nname: gone\n---\nproject gone\n"),
    write(roots.library, "skills/gone/SKILL.md", "---\nname: gone\n---\nlibrary gone\n"),
  ]);

  const active = await listActiveWorkbenchSkillDefinitions(await listProjectSkillsFromRoot(roots.project), roots.home);
  const fixtureBodies = active.filter(skill => ["gone", "kept", "renamed", "shared"].includes(skill.name))
    .map(skill => skill.content.split("\n").at(-1));
  assert.deepEqual(fixtureBodies.sort(), ["local shared", "project kept"]);
});

test("local agents replace project agents under canonical paths and tombstones hide them", async (context) => {
  const roots = await createFixture(context);
  const { listUserInvocableAgentsFromResolvedProject, readUserInvocableAgentDefinitionFromRoot } = await import("./project-agents-folder");
  await Promise.all([
    write(roots.project, ".agents/agents/lily.md", "---\nname: Lily\n---\nproject lily\n"),
    write(roots.project, ".agents.local/agents/lily.md", "---\nname: Lily\n---\nlocal lily\n"),
    write(roots.project, ".agents.local/agents/mine.md", "local mine\n"),
    write(roots.project, ".agents/agents/kept.md", "project kept\n"),
    write(roots.project, ".agents/agents/hidden.md", "project hidden\n"),
    write(roots.project, ".agents.local/agents/hidden.tombstone", ""),
  ]);
  const project = {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    kind: "git" as const,
    root: roots.project,
    rootPath: roots.project,
    roots: [{ id: "project", name: "project", root: roots.project, rootPath: roots.project }],
  };

  const listed = (await listUserInvocableAgentsFromResolvedProject(project)).filter(agent => agent.source === "project");
  assert.deepEqual(listed.map(agent => agent.path).sort(), [".agents/agents/kept.md", ".agents/agents/lily.md", ".agents/agents/mine.md"]);
  assert.equal((await readUserInvocableAgentDefinitionFromRoot(".agents/agents/lily.md", roots.project)).prompt, "local lily");
  assert.equal((await readUserInvocableAgentDefinitionFromRoot(".agents/agents/mine.md", roots.project)).prompt, "local mine");
  assert.equal((await readUserInvocableAgentDefinitionFromRoot(".agents/agents/kept.md", roots.project)).prompt, "project kept");
  await assert.rejects(readUserInvocableAgentDefinitionFromRoot(".agents/agents/hidden.md", roots.project), /tombstone/u);
});
