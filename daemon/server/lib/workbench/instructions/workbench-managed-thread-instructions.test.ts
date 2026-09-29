/* Exports: none. Protect managed-thread skill manifests, activation-only bodies, and capability-driven mechanics. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";

const originalWorkbenchLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;
let managed: typeof import("./workbench-managed-thread-instructions");
let libraryRoot = "";
let projectRoot = "";
let temporary: WorkbenchTemporaryDirectory | null = null;

before(async () => {
  temporary = await WorkbenchTemporaryDirectory.create("workbench-managed-instructions-");
  libraryRoot = temporary.path;
  projectRoot = path.join(temporary.path, "project");
  await fs.mkdir(projectRoot, { recursive: true });
  process.env.WORKBENCH_LIBRARY_ROOT = libraryRoot;
  managed = await import("./workbench-managed-thread-instructions");
});

after(async () => {
  if (originalWorkbenchLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
  else process.env.WORKBENCH_LIBRARY_ROOT = originalWorkbenchLibraryRoot;
  await temporary?.dispose();
});

function createContext(activatedSkillPaths: readonly string[] = []) {
  return {
    activatedSkillPaths,
    cwd: projectRoot,
    harness: "opencode" as const,
    managedThread: true,
    model: "gpt-test",
    readInstructionTools: async () => [
      { id: "rg", codeModeEligible: true },
      { id: "git_arc_release", codeModeEligible: false },
    ],
    roots: [{ id: "project", isPrimary: true, name: "project", relativePath: "project", rootPath: projectRoot }],
    threadId: "managed-thread",
  };
}

const readNoLocalCapabilities = async () => ({ browseRawCommandsEnabled: false });

test("managed prompts carry skill manifests while only activation carries bodies", async () => {
  const skillPath = path.join(projectRoot, ".agents", "skills", "iterate", "SKILL.md");
  const bodyMarker = "FRESH ITERATE SKILL BODY";
  const override = path.join(libraryRoot, "AGENTS.override.md");
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.mkdir(libraryRoot, { recursive: true });
  await fs.writeFile(skillPath, `---
name: iterate
description: Use when the user says /iterate.
---

${bodyMarker}
`, "utf8");
  await fs.writeFile(override, "{skills.catalog}\n", "utf8");
  const manifestEntry = `<skill filename="${skillPath.replaceAll("\\", "/")}" trigger="Use when the user says /iterate." />`;

  try {
    const instructions = await managed.buildWorkbenchManagedThreadInstructions(createContext(), readNoLocalCapabilities);
    const prompt = [instructions.baseInstructions ?? "", instructions.developerInstructions ?? ""].join("\n");
    assert.ok(prompt.includes(manifestEntry));
    assert.doesNotMatch(prompt, new RegExp(bodyMarker, "u"));
    assert.doesNotMatch(prompt, /<\/skill>/u);

    const activatedSkills = await managed.buildWorkbenchManagedThreadActivatedSkills(
      createContext([skillPath]),
      readNoLocalCapabilities,
    );
    assert.match(activatedSkills ?? "", new RegExp(bodyMarker, "u"));
    assert.ok((activatedSkills ?? "").includes(manifestEntry.replace(" />", ">")));
  } finally {
    await Promise.all([override, skillPath].map(file => fs.rm(file, { force: true })));
  }
});

test("managed mechanics availability follows injected local capabilities", async () => {
  const override = path.join(libraryRoot, "AGENTS.override.md");
  const rawMarker = "RAW BROWSE MECHANIC MARKER";
  await fs.mkdir(libraryRoot, { recursive: true });
  await fs.writeFile(override, [
    "base policy",
    "<available:browse-raw>",
    rawMarker,
    "</available:browse-raw>",
  ].join("\n"), "utf8");

  try {
    const enabled = await managed.buildWorkbenchManagedThreadInstructions(
      createContext(),
      async () => ({ browseRawCommandsEnabled: true }),
    );
    const disabled = await managed.buildWorkbenchManagedThreadInstructions(
      createContext(),
      readNoLocalCapabilities,
    );
    assert.match(enabled.baseInstructions ?? "", new RegExp(rawMarker, "u"));
    assert.doesNotMatch(enabled.baseInstructions ?? "", /<available:browse-raw>/u);
    assert.doesNotMatch(disabled.baseInstructions ?? "", new RegExp(rawMarker, "u"));
  } finally {
    await fs.rm(override, { force: true });
  }
});

test("managed instructions and activated skills render provider tool references", async () => {
  const override = path.join(libraryRoot, "AGENTS.override.md");
  const skillPath = path.join(projectRoot, ".agents", "skills", "tools", "SKILL.md");
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(override, 'use <tool id="rg" /> and <tool id="git_arc_release" />.\n', "utf8");
  await fs.writeFile(skillPath, "---\nname: tools\ndescription: Use when asked for /tools.\n---\n\ncall <tool id=\"git_arc_release\" />.\n", "utf8");
  try {
    const opencode = await managed.buildWorkbenchManagedThreadInstructions(createContext(), readNoLocalCapabilities);
    assert.match(opencode.baseInstructions ?? "", /`tools\.wb\.rg` and `tools\.wb\.git_arc_release`/u);
    assert.doesNotMatch(opencode.baseInstructions ?? "", /<tool id=/u);
    const codex = await managed.buildWorkbenchManagedThreadInstructions({
      ...createContext(), harness: "codex",
    }, readNoLocalCapabilities);
    assert.match(codex.baseInstructions ?? "", /`tools\.mcp__wb__rg` and `tools\.mcp__wbex__git_arc_release`/u);
    const activated = await managed.buildWorkbenchManagedThreadActivatedSkills(
      createContext([skillPath]), readNoLocalCapabilities,
    );
    assert.match(activated ?? "", /`tools\.wb\.git_arc_release`/u);
  } finally {
    await Promise.all([override, skillPath].map(file => fs.rm(file, { force: true })));
  }
});
