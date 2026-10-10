/* No production exports. Git-backed wards for edit session previews, claim-gated apply, publish rollback, revert merges and ignored-only sessions. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { GitArcEditOperationSchema } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import { runGitArcEditOperations } from "./git-arc-edit-operations.ts";
import GitArcEditPlanner from "./GitArcEditPlanner.ts";
import GitArcEditSessionController, { type GitArcEditArcPort } from "./GitArcEditSessionController.ts";
import GitArcRegistry from "./GitArcRegistry.ts";
import GitTestFixtureCache from "./GitTestFixtureCache.ts";
import WorkbenchGitCheckpointController from "./WorkbenchGitCheckpointController.ts";
import WorkbenchGitRepository from "./WorkbenchGitRepository.ts";
import { EDIT_SESSION_ARC_READY_FIXTURE } from "./WorkbenchGitTestFixtures.ts";

const fixtureCache = new GitTestFixtureCache();
const cases: Array<{ name: string; run: (context: TestContext) => Promise<void> }> = [];
const noPending = async () => [];
const TS_IMPORTS = {
  aliases: { "@/": "src" },
  extensions: [".tsx", ".ts"],
  globs: ["*.ts", "*.tsx"],
  pattern: String.raw`(?:from|import)\s*\(?\s*['"](?<path>[^'"]+)['"]`,
};

function editTest(name: string, run: (context: TestContext) => Promise<void>) {
  cases.push({ name, run });
}

function operations(values: object[]) {
  return values.map(value => GitArcEditOperationSchema.parse(value));
}

async function setup(context: TestContext, arcPort?: (port: GitArcEditArcPort) => GitArcEditArcPort) {
  const fixture = await fixtureCache.copy(EDIT_SESSION_ARC_READY_FIXTURE);
  context.after(fixture.dispose);
  const root = fixture.root;
  const checkpoints = new WorkbenchGitCheckpointController();
  const port = arcPort ? arcPort(checkpoints.editArcPort) : checkpoints.editArcPort;
  // Operations run in-process: the worker only moves them off the event loop.
  const sessions = new GitArcEditSessionController(port, undefined, new GitArcEditPlanner(async input => runGitArcEditOperations(input)));
  const owner = { cwd: root, harness: "codex" as const, threadId: "edit-thread" };
  const read = async (file: string) => await fs.readFile(path.join(root, file), "utf8");
  return { owner, read, registry: new GitArcRegistry(await WorkbenchGitRepository.open(root)), root, sessions };
}

editTest("previews write nothing, apply moves and rewrites references under claims, and end keeps the result", async (context) => {
  const { owner, read, registry, root, sessions } = await setup(context);
  const markdown = { globs: ["*.md"], pattern: String.raw`\]\((?<path>[^)]+)\)` };
  const preview = await sessions.start({
    checkPending: noPending, owner,
    operations: operations([{ from: "src/components/Widget.tsx", kind: "move", references: [TS_IMPORTS, markdown], to: "src/ui/Widget.tsx" }]),
  });
  assert.equal(preview.phase, "preview");
  assert.deepEqual(preview.files.map(({ lines, movedFrom, path: filePath }) => ({ lines, movedFrom, path: filePath })), [
    { lines: [1], movedFrom: undefined, path: "docs/notes.md" },
    { lines: [1], movedFrom: undefined, path: "src/app.tsx" },
    { lines: [], movedFrom: "src/components/Widget.tsx", path: "src/ui/Widget.tsx" },
  ]);
  assert.equal(await read("src/app.tsx"), "import Widget from \"./components/Widget\";\nimport { helper } from \"@/lib/helper\";\n\nexport default Widget;\n");
  await assert.rejects(fs.access(path.join(root, "src/ui/Widget.tsx")));

  const viewed = await sessions.view({ diffs: ["src/app.tsx:1", "src/components/Widget.tsx"], owner, page: 1 });
  assert.match(viewed.diffs[0]!.patch, /^\+import Widget from "\.\/ui\/Widget";$/mu);
  assert.match(viewed.diffs[1]!.patch, /No content changes; moved from src\/components\/Widget\.tsx/u);

  const applied = await sessions.tryApply({ checkPending: noPending, owner });
  assert.equal(applied.kind, "applied");
  if (applied.kind !== "applied") return;
  assert.equal(applied.result.matchedPreview, true);
  assert.equal(await read("src/ui/Widget.tsx"), "export default function Widget() {\n  return null;\n}\n");
  await assert.rejects(fs.access(path.join(root, "src/components")), "emptied source folders are pruned");
  assert.match(await read("src/app.tsx"), /from "\.\/ui\/Widget"/u);
  assert.equal(await read("docs/notes.md"), "See [widget](../src/ui/Widget.tsx).\n");
  assert.deepEqual((await registry.find({ harness: "codex", threadId: "edit-thread" }))?.claimedPaths,
    ["docs/notes.md", "src/app.tsx", "src/components/Widget.tsx", "src/ui/Widget.tsx"]);

  await assert.rejects(sessions.start({ checkPending: noPending, owner, operations: operations([{ kind: "replace", pattern: "a", replacement: "b" }]) }), /is applied/u);
  assert.equal((await sessions.end({ owner })).phase, "ended");
  await assert.rejects(sessions.view({ diffs: [], owner, page: 1 }), /no edit session/u);
  assert.match(await read("src/app.tsx"), /from "\.\/ui\/Widget"/u);
});

editTest("sibling claims block apply while unclaimed dirt and pending proposal paths reject it", async (context) => {
  const { owner, read, registry, root, sessions } = await setup(context);
  await registry.claim({
    checkpointCommit: await (await WorkbenchGitRepository.open(root)).currentHead(),
    claimedPaths: ["src/lib/helper.ts"], harness: "opencode", intentDescription: "", intentName: "helper work",
    proposalId: null, threadId: "sibling",
  });
  const replaceWidget = operations([{ kind: "replace", pattern: String.raw`\bWidget\b`, replacement: "Gadget", roots: ["src"] }]);
  const preview = await sessions.start({ checkPending: noPending, operations: replaceWidget, owner });
  assert.deepEqual(preview.collisions, [{ owner: "helper work", paths: ["src/lib/helper.ts"], threadId: "sibling" }]);
  assert.deepEqual(await sessions.tryApply({ checkPending: noPending, owner }), { kind: "blocked" });
  assert.match(await read("src/lib/helper.ts"), /"Widget"/u);

  await fs.writeFile(path.join(root, "src/app.tsx"), "import Widget from \"./components/Widget\";\n// local change\n");
  const appOnly = operations([{ globs: ["app.tsx"], kind: "replace", pattern: String.raw`\bWidget\b`, replacement: "Gadget", roots: ["src"] }]);
  assert.deepEqual((await sessions.start({ checkPending: noPending, operations: appOnly, owner })).blockedDirtyPaths, ["src/app.tsx"]);
  await assert.rejects(sessions.tryApply({ checkPending: noPending, owner }), /unclaimed dirty paths.*src\/app\.tsx/u);

  const widgetOnly = operations([{ globs: ["Widget.tsx"], kind: "replace", pattern: String.raw`\bWidget\b`, replacement: "Gadget", roots: ["src"] }]);
  const pending = async (absolutePaths: string[]) => absolutePaths;
  assert.deepEqual((await sessions.start({ checkPending: pending, operations: widgetOnly, owner })).blockedPendingPaths, ["src/components/Widget.tsx"]);
  await assert.rejects(sessions.tryApply({ checkPending: pending, owner }), /pending proposals/u);
  assert.match(await read("src/components/Widget.tsx"), /function Widget/u);
});

editTest("a failed publication restores every written file and keeps the session in preview", async (context) => {
  const { owner, read, root, sessions } = await setup(context, port => ({
    ...port,
    claimAndWrite: async ({ write }) => await write(async () => { throw new Error("publish failed"); }, []),
  }));
  await sessions.start({
    checkPending: noPending, owner,
    operations: operations([
      { from: "src/components", kind: "move", references: [TS_IMPORTS], to: "src/ui" },
      { kind: "replace", pattern: "helper", replacement: "assist", roots: ["src/lib"] },
    ]),
  });
  await assert.rejects(sessions.tryApply({ checkPending: noPending, owner }), /publish failed/u);
  assert.match(await read("src/components/Widget.tsx"), /function Widget/u);
  assert.match(await read("src/lib/helper.ts"), /helper/u);
  assert.match(await read("src/app.tsx"), /"\.\/components\/Widget"/u);
  await assert.rejects(fs.access(path.join(root, "src/ui")));
  assert.equal((await sessions.view({ diffs: [], owner, page: 1 })).phase, "preview");
});

editTest("revert reverse-applies onto current files, keeping later edits and marking conflicts", async (context) => {
  const { owner, read, registry, root, sessions } = await setup(context);
  await sessions.start({
    checkPending: noPending, owner,
    operations: operations([{ kind: "replace", pattern: String.raw`\bWidget\b`, replacement: "Gadget", roots: ["src"] }]),
  });
  assert.equal((await sessions.tryApply({ checkPending: noPending, owner })).kind, "applied");
  await fs.writeFile(path.join(root, "src/app.tsx"), (await read("src/app.tsx")).replace("\n\n", "\n// later edit\n\n"));
  await fs.writeFile(path.join(root, "src/lib/helper.ts"), "export const helper = \"Contraption\";\n");

  const reverted = await sessions.revert({ checkPending: noPending, owner });
  assert.equal(reverted.phase, "reverted");
  assert.deepEqual(reverted.conflictedPaths, ["src/lib/helper.ts"]);
  assert.equal(await read("src/app.tsx"), "import Widget from \"./components/Widget\";\nimport { helper } from \"@/lib/helper\";\n// later edit\n\nexport default Widget;\n");
  assert.match(await read("src/lib/helper.ts"), /^<<<<<<< /mu);
  assert.equal(await read("src/components/Widget.tsx"), "export default function Widget() {\n  return null;\n}\n");
  assert.deepEqual(reverted.releasedClaims, ["src/components/Widget.tsx"], "only session claims that ended clean are released");
  assert.deepEqual((await registry.find({ harness: "codex", threadId: "edit-thread" }))?.claimedPaths,
    ["docs/notes.md", "src/app.tsx", "src/lib/helper.ts"]);
});

editTest("ignored-only sessions apply and revert without an arc or claims", async (context) => {
  const { owner: arcOwner, read, registry, root, sessions } = await setup(context);
  const owner = { ...arcOwner, threadId: "loose-thread" };
  await fs.mkdir(path.join(root, ".local"), { recursive: true });
  await fs.writeFile(path.join(root, ".local/config.json"), "{\"host\":\"old\"}\n");
  const replaceHost = operations([{ kind: "replace", pattern: "old", replacement: "new", roots: [".local"] }]);
  await assert.rejects(sessions.start({ checkPending: noPending, operations: replaceHost, owner }), /change no files/u);

  const preview = await sessions.start({
    checkPending: noPending, owner,
    operations: operations([{ includeIgnored: true, kind: "replace", pattern: "old", replacement: "new", roots: [".local"] }]),
  });
  assert.deepEqual(preview.files.map(({ ignored, path: filePath }) => ({ ignored, path: filePath })), [{ ignored: true, path: ".local/config.json" }]);
  assert.equal((await sessions.tryApply({ checkPending: noPending, owner })).kind, "applied");
  assert.equal(await read(".local/config.json"), "{\"host\":\"new\"}\n");
  assert.equal(await registry.find({ harness: "codex", threadId: "loose-thread" }), null);
  await sessions.revert({ checkPending: noPending, owner });
  assert.equal(await read(".local/config.json"), "{\"host\":\"old\"}\n");
});

test("Git arc edit sessions", { concurrency: 5 }, async (context) => {
  await Promise.all(cases.map(async ({ name, run }) => await context.test(name, { concurrency: true }, run)));
});
