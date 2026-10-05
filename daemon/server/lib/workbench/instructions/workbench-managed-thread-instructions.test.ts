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

test("remote repository guidance follows one current audience tool catalogue", async () => {
  const input = '<available:remote-repos>read with <tool id="git_repo" /></available:remote-repos>';
  for (const harness of ["codex", "opencode", "claude"] as const) {
    for (const subagentName of [null, "mira"]) {
      let available = false;
      let reads = 0;
      const context = {
        ...createContext(), harness, subagentName,
        readInstructionTools: async () => {
          reads++;
          return available ? [{ id: "git_repo", codeModeEligible: false }] : [];
        },
      };
      for (const enabled of [true, false, true]) {
        available = enabled;
        const before = reads;
        const filter = await managed.createManagedThreadFilter(context, readNoLocalCapabilities);
        const output = filter(input, "policy") ?? "";
        assert.equal(reads - before, 1);
        if (enabled) {
          const reference = harness === "codex" ? "tools.mcp__wbex__git_repo"
            : harness === "opencode" ? "tools.wb.git_repo" : "mcp__wb__git_repo";
          assert.equal(output, `read with \`${reference}\``);
        } else {
          assert.equal(output, "");
        }
      }
    }
  }
});

test("failed instruction tool catalogue reads propagate instead of guessing availability", async () => {
  const failure = new Error("catalogue unavailable");
  await assert.rejects(managed.createManagedThreadFilter({
    ...createContext(),
    readInstructionTools: async () => { throw failure; },
  }, readNoLocalCapabilities), error => error === failure);
});

test("proposal instructions resolve for parents but become handoff instructions for children", async () => {
  const base = createContext();
  const tools = async () => [{ id: "git_arc_propose", codeModeEligible: false }];
  const input = [
    "<>",
    "<available:git-proposals>propose with <tool id=\"git_arc_propose\" /></available:git-proposals>",
    "<else>handoff</else>",
    "</>",
  ].join("\n");
  const parent = await managed.createManagedThreadFilter({ ...base, readInstructionTools: tools }, readNoLocalCapabilities);
  const child = await managed.createManagedThreadFilter({
    ...base, readInstructionTools: tools, subagentName: "mira",
  }, readNoLocalCapabilities);
  assert.match(parent(input, "policy") ?? "", /tools\.wb\.git_arc_propose/u);
  assert.doesNotMatch(parent(input, "policy") ?? "", /handoff/u);
  assert.equal(child(input, "policy"), "handoff");
});

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
  const manifestEntry = '<skill name="iterate" trigger="Use when the user says /iterate." />';

  try {
    const instructions = await managed.buildWorkbenchManagedThreadInstructions(createContext(), readNoLocalCapabilities);
    const prompt = [instructions.baseInstructions ?? "", instructions.developerInstructions ?? ""].join("\n");
    assert.ok(prompt.includes(manifestEntry));
    assert.doesNotMatch(prompt, /<skill filename=/u);
    assert.doesNotMatch(prompt, new RegExp(bodyMarker, "u"));
    assert.doesNotMatch(prompt, /<\/skill>/u);

    const activatedSkills = await managed.buildWorkbenchManagedThreadActivatedSkills(
      createContext([skillPath]),
      readNoLocalCapabilities,
    );
    assert.match(activatedSkills ?? "", new RegExp(bodyMarker, "u"));
    assert.ok((activatedSkills ?? "").includes(manifestEntry.replace(" />", ">")));
    assert.doesNotMatch(activatedSkills ?? "", /<skill filename=/u);
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

test("slash-activated skills render source-relative imports and overrides before filtering", async () => {
  const projectSkillDirectory = path.join(projectRoot, ".agents", "skills", "expand");
  const librarySkillDirectory = path.join(libraryRoot, "skills", "library-expand");
  const projectSkillPath = path.join(projectSkillDirectory, "SKILL.md");
  const librarySkillPath = path.join(librarySkillDirectory, "SKILL.md");
  await Promise.all([
    fs.mkdir(projectSkillDirectory, { recursive: true }),
    fs.mkdir(librarySkillDirectory, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(projectSkillPath, "---\nname: expand\ndescription: Project expansion.\n---\nbase body\n"),
    fs.writeFile(path.join(projectSkillDirectory, "SKILL.override.md"), [
      "---", "name: expand", "description: Project expansion.", "---",
      "project {./reference.md}",
      "<!-- private note -->",
      "<harness:opencode>call <tool id=\"rg\" /></harness:opencode>",
      "<model:gpt-other>wrong model</model:gpt-other>",
    ].join("\n")),
    fs.writeFile(path.join(projectSkillDirectory, "reference.md"), "project reference content\n"),
    fs.writeFile(librarySkillPath, "---\nname: library-expand\ndescription: Library expansion.\n---\nlibrary {./reference.md}\n"),
    fs.writeFile(path.join(librarySkillDirectory, "reference.md"), "library reference content\n"),
  ]);

  try {
    const output = await managed.buildWorkbenchManagedThreadActivatedSkills(
      createContext([projectSkillPath, librarySkillPath]), readNoLocalCapabilities,
    );
    assert.match(output ?? "", /project project reference content/u);
    assert.match(output ?? "", /library library reference content/u);
    assert.match(output ?? "", /`tools\.wb\.rg`/u);
    assert.doesNotMatch(output ?? "", /base body|private note|wrong model|\{\.\/reference\.md\}|name: expand/u);
    assert.equal((output ?? "").split("<skill ").length - 1, 2);

    await fs.writeFile(path.join(projectSkillDirectory, "SKILL.override.md"), "---\nname: expand\n---\n{./../../../../outside.md}\n");
    await assert.rejects(
      managed.buildWorkbenchManagedThreadActivatedSkills(
        createContext([projectSkillPath]), readNoLocalCapabilities,
      ),
      /escapes the selected skill source/u,
    );
  } finally {
    await Promise.all([
      fs.rm(projectSkillDirectory, { recursive: true, force: true }),
      fs.rm(librarySkillDirectory, { recursive: true, force: true }),
    ]);
  }
});
