/*
 * No production exports. Tests protect that a build pins exactly the prefix its stored input rebuilds, that unidentified builds
 * pin nothing, that a thread's skill list stays as its prefix froze it until compaction asks for a refreeze, and that activated skill
 * bodies are filtered fresh from disk and pinned.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../database/workbench-database-schema";
import WorkbenchThreadInstructionOverlayStore from "../database/thread-state/WorkbenchThreadInstructionOverlayStore";
import type { WorkbenchInstructionPin } from "./WorkbenchThreadInstructionPins";

const originalLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;
let library: WorkbenchTemporaryDirectory | null = null;
let Builder: typeof import("./WorkbenchThreadInstructionBuilder.js").default;
let Pins: typeof import("./WorkbenchThreadInstructionPins.js").default;
let readTools: () => Promise<readonly import("../lib/workbench/instructions/instruction-tool-reference.js").WorkbenchInstructionTool[]>;

before(async () => {
  library = await WorkbenchTemporaryDirectory.create("workbench-instruction-builder-library-");
  process.env.WORKBENCH_LIBRARY_ROOT = library.path;
  // The prompt library reads its root at import.
  Builder = (await import("./WorkbenchThreadInstructionBuilder.js")).default;
  Pins = (await import("./WorkbenchThreadInstructionPins.js")).default;
  const { listWorkbenchInstructionTools } = await import("../lib/workbench/instructions/instruction-tool-reference.js");
  const { listWorkbenchAgentCommands } = await import("../lib/workbench/commands/workbench-agent-command-registry.js");
  readTools = async () => listWorkbenchInstructionTools(listWorkbenchAgentCommands());
});

after(async () => {
  if (originalLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
  else process.env.WORKBENCH_LIBRARY_ROOT = originalLibraryRoot;
  await library?.dispose();
});

/** A builder over the real pins and store, for one thread row named "thread". */
function builder(context: TestContext, root: string) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(testProjectIds.project);
  database.prepare(`INSERT INTO workbench_threads
    (id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at)
    VALUES ('thread', ?, ?, 'thread', 1, 1, 1, 1)`).run(testProjectIds.project, root);
  context.after(() => database.close());
  const store = new WorkbenchThreadInstructionOverlayStore(database);
  const storedPins = new Pins({
    execute: async command => store.execute(command),
    readToolFingerprint: async () => "tools",
    rebuildPrefixHash: async prefix => await owner.prefixHash(prefix),
  });
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
    pins: {
      pin: async (threadId, pin) => { pins.push({ threadId, pin }); await storedPins.pin(threadId, pin); },
      readSkills: threadId => storedPins.readSkills(threadId),
    },
  });
  return { owner, pins, roots, storedPins };
}

const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

async function writeSkill(root: string, name: string, description: string, body: string) {
  const file = path.join(root, ".agents", "skills", name, "SKILL.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, skill(name, description, body), "utf8");
  return file;
}

test("a build pins the prefix its stored input rebuilds, and a build without a thread pins nothing", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-instruction-builder-");
  context.after(() => temporary.dispose());
  await fs.writeFile(path.join(temporary.path, "AGENTS.md"), "project rule\n", "utf8");
  const { owner, pins, roots } = builder(context, temporary.path);
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
});

test("a thread's skill list stays as its prefix froze it, keeps what the agent was told, and refreezes after compaction", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-instruction-builder-frozen-");
  context.after(() => temporary.dispose());
  const root = temporary.path;
  await writeSkill(root, "alpha", "Use for alpha.", "ALPHA");
  const { owner, pins, storedPins } = builder(context, root);
  const request = { harness: "claude" as const, model: "model", threadId: "thread", projectId: "project", cwd: root };
  const hashOf = (index: number) => {
    const pin = pins[index]?.pin;
    return pin && "base" in pin ? pin.prefix?.hash : undefined;
  };

  assert.match((await owner.build(request)).baseInstructions ?? "", /<skill name="alpha"/u);
  await writeSkill(root, "beta", "Use for beta.", "BETA");
  assert.doesNotMatch((await owner.build(request)).baseInstructions ?? "", /name="beta"/u, "a new skill never rewrites the prefix");
  assert.equal(hashOf(1), hashOf(0));
  assert.equal(await storedPins.prefixStale("thread"), false, "skill edits never make the prefix stale");

  const told = (await storedPins.readSkills("thread"))!;
  const names = (entries: readonly { name: string }[]) => entries.map(entry => entry.name).filter(name => /^(alpha|beta)$/u.test(name));
  assert.deepEqual(names(told.frozen), ["alpha"]);
  const live = [...told.frozen, { name: "beta", trigger: "Use for beta.", digest: "beta" }];
  await storedPins.noteSkills("thread", live);
  await owner.build(request);
  assert.deepEqual((await storedPins.readSkills("thread"))?.known, live, "what the agent was told outlives a re-pin");

  await storedPins.refreezeSkills("thread");
  assert.deepEqual(await storedPins.readSkills("thread"), { frozen: told.frozen, known: told.frozen, refreeze: true });
  assert.match((await owner.build(request)).baseInstructions ?? "", /name="beta"/u);
  const refrozen = (await storedPins.readSkills("thread"))!;
  assert.deepEqual(names(refrozen.frozen), ["alpha", "beta"]);
  assert.equal(refrozen.refreeze, false);
  assert.deepEqual(refrozen.known, refrozen.frozen);
});

test("activated skill bodies are filtered fresh from disk and pinned as the thread's skill layers", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-instruction-builder-skills-");
  context.after(() => temporary.dispose());
  const root = temporary.path;
  const iterate = await writeSkill(root, "iterate", "Use when the user says /iterate & the project allows it.", "FRESH ITERATE BODY");
  await writeSkill(root, "brainstorm", "Use when the user says /brainstorm.", "INACTIVE BRAINSTORM BODY");
  const { owner, pins } = builder(context, root);
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
});
