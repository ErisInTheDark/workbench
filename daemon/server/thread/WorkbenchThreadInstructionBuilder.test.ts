/*
 * No production exports. Tests protect that a build pins exactly the prefix its stored input rebuilds, that unidentified builds
 * pin nothing, and that activated skill bodies are filtered fresh from disk and pinned.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import type { WorkbenchInstructionPin } from "./WorkbenchThreadInstructionPins";

const originalLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;
let library: WorkbenchTemporaryDirectory | null = null;
let Builder: typeof import("./WorkbenchThreadInstructionBuilder.js").default;
let readTools: () => Promise<readonly import("../lib/workbench/instructions/instruction-tool-reference.js").WorkbenchInstructionTool[]>;

before(async () => {
  library = await WorkbenchTemporaryDirectory.create("workbench-instruction-builder-library-");
  process.env.WORKBENCH_LIBRARY_ROOT = library.path;
  // The prompt library reads its root at import.
  Builder = (await import("./WorkbenchThreadInstructionBuilder.js")).default;
  const { listWorkbenchInstructionTools } = await import("../lib/workbench/instructions/instruction-tool-reference.js");
  const { listWorkbenchAgentCommands } = await import("../lib/workbench/commands/workbench-agent-command-registry.js");
  readTools = async () => listWorkbenchInstructionTools(listWorkbenchAgentCommands());
});

after(async () => {
  if (originalLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
  else process.env.WORKBENCH_LIBRARY_ROOT = originalLibraryRoot;
  await library?.dispose();
});

function builder(root: string) {
  const pins: Array<{ threadId: string; pin: WorkbenchInstructionPin }> = [];
  const roots: string[] = [];
  const owner = new Builder({
    readRoots: async projectId => {
      roots.push(projectId);
      return [{ id: "project", isPrimary: true, name: "project", relativePath: ".", rootPath: root }];
    },
    readInstructionTools: () => readTools(),
    readLocalCapabilities: async () => ({ browseRawCommandsEnabled: false }),
    workbenchOrigin: "http://127.0.0.1:4500",
    pin: async (threadId, pin) => { pins.push({ threadId, pin }); },
  });
  return { owner, pins, roots };
}

test("a build pins the prefix its stored input rebuilds, and a build without a thread pins nothing", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-instruction-builder-");
  try {
    await fs.writeFile(path.join(temporary.path, "AGENTS.md"), "project rule\n", "utf8");
    const { owner, pins, roots } = builder(temporary.path);
    const request = { harness: "claude" as const, model: "model", projectId: "project", cwd: temporary.path, workflowIds: ["default"] };
    const built = await owner.build({ ...request, threadId: "thread" });
    assert.match(built.developerInstructions ?? "", /project rule/u);
    assert.deepEqual(roots, ["project"], "roots come from the project when the caller has none");
    const [pinned] = pins;
    assert.equal(pinned?.threadId, "thread");
    const prefix = pinned && "base" in pinned.pin ? pinned.pin.prefix : null;
    assert.ok(prefix);
    assert.equal(prefix.context.workbenchOrigin, "http://127.0.0.1:4500");
    assert.equal(await owner.prefixHash(prefix.context), prefix.hash);

    await owner.build({ ...request, threadId: null });
    assert.equal(pins.length, 1);
  } finally {
    await temporary.dispose();
  }
});

test("activated skill bodies are filtered fresh from disk and pinned as the thread's skill layers", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-instruction-builder-skills-");
  const root = temporary.path;
  const iterate = path.join(root, ".agents", "skills", "iterate", "SKILL.md");
  const brainstorm = path.join(root, ".agents", "skills", "brainstorm", "SKILL.md");
  const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  try {
    await fs.mkdir(path.dirname(iterate), { recursive: true });
    await fs.mkdir(path.dirname(brainstorm), { recursive: true });
    await fs.writeFile(iterate, skill("iterate", "Use when the user says /iterate & the project allows it.", "FRESH ITERATE BODY"), "utf8");
    await fs.writeFile(brainstorm, skill("brainstorm", "Use when the user says /brainstorm.", "INACTIVE BRAINSTORM BODY"), "utf8");
    const { owner, pins } = builder(root);
    const request = { harness: "codex" as const, model: null, threadId: "thread", projectId: "project", cwd: root };

    const catalog = await owner.skills(request, [iterate, iterate]) ?? "";
    assert.match(catalog, /FRESH ITERATE BODY/u);
    assert.doesNotMatch(catalog, /INACTIVE BRAINSTORM BODY|\nname: iterate\n|<skill filename=/u);
    assert.ok(catalog.includes('<skill name="iterate" trigger="Use when the user says /iterate &amp; the project allows it.">'));
    assert.equal(pins.length, 1);
    assert.ok("skills" in pins[0]!.pin && pins[0]!.pin.skills.length === 1);

    await fs.writeFile(iterate, skill("iterate", "Use when the user says /iterate.", "REVISED ITERATE BODY"), "utf8");
    const revised = await owner.skills(request, [iterate]) ?? "";
    assert.match(revised, /REVISED ITERATE BODY/u);
    assert.doesNotMatch(revised, /FRESH ITERATE BODY/u);
    assert.equal(await owner.skills(request, [path.join(root, "arbitrary.md")]), null);
  } finally {
    await temporary.dispose();
  }
});
