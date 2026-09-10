/* No production exports. Tests protect thread Git validation, response compatibility, and worktree-wide transition serialization. */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchThreadGitFeature from "./WorkbenchThreadGitFeature";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";

function threadGitIdentities() {
  const database = createThreadStateTestDatabase();
  for (const nativeId of ["thread-one", "thread-two", "thread-three"]) {
    database.admitThread("project", `wb:${nativeId}`, "codex", nativeId);
  }
  return database.identities.threads;
}

test("preserves thread Git selection and commit responses behind the orchestrator boundary", async () => {
  const feature = new WorkbenchThreadGitFeature({
    identities: threadGitIdentities(),
    createThreadGit: async () => ({
      add: async () => ({ changedPaths: ["src/one.ts"], selectedPaths: ["src/one.ts"] }),
      commit: async () => ({ commit: "a".repeat(40), committedPaths: ["src/one.ts"], selectedPaths: ["src/one.ts"] }),
      repoRoot: "C:/Git/Project",
      unstage: async () => ({ changedPaths: ["src/one.ts"], selectedPaths: [] }),
    }),
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project" }),
    transitions: new WorkbenchThreadTransitionCoordinator(),
  });

  const selected = await feature.executeRequest({
    action: "add", cwd: "C:/Git/Project", paths: ["src/one.ts"], threadId: "thread-one",
  });
  assert.equal(selected.status, 200);
  assert.equal(await selected.text(), "Selected 1 file.\nThread selection (1):\n  src/one.ts\n");

  const committed = await feature.executeRequest({
    action: "commit", cwd: "C:/Git/Project", message: "commit one", threadId: "thread-one",
  });
  assert.equal(committed.status, 200);
  assert.match(await committed.text(), new RegExp(`^Committed ${"a".repeat(40)}\\nCommitted files \\(1\\):\\n  src/one\\.ts`, "u"));

  const invalid = await feature.executeRequest({ action: "commit", cwd: "C:/Git/Project" });
  assert.equal(invalid.status, 400);
  assert.match(JSON.stringify(await invalid.json()), /managed Workbench thread id is required/u);
});

test("serializes sibling thread Git operations per worktree while unrelated worktrees proceed", async () => {
  const transitions = new WorkbenchThreadTransitionCoordinator();
  const events: string[] = [];
  let releaseFirst = () => undefined;
  let announceFirst = () => undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
  const feature = new WorkbenchThreadGitFeature({
    identities: threadGitIdentities(),
    createThreadGit: async ({ targetWorktree, threadId }) => ({
      add: async () => ({ changedPaths: [], selectedPaths: [] }),
      commit: async () => {
        events.push(`${threadId}:start`);
        if (threadId === "thread-one") {
          announceFirst();
          await firstGate;
        }
        events.push(`${threadId}:end`);
        return { commit: "a".repeat(40), committedPaths: [], selectedPaths: [] };
      },
      repoRoot: targetWorktree ?? "C:/Git/Project",
      unstage: async () => ({ changedPaths: [], selectedPaths: [] }),
    }),
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project" }),
    transitions,
  });
  const request = (threadId: string, targetWorktree?: string) => feature.executeRequest({
    action: "commit", cwd: "C:/Git/Project", message: threadId, ...(targetWorktree ? { targetWorktree } : {}), threadId,
  });

  const first = request("thread-one");
  await firstStarted;
  const sibling = request("thread-two");
  const unrelated = request("thread-three", "D:/Git/Other");
  await unrelated;
  assert.deepEqual(events, ["thread-one:start", "thread-three:start", "thread-three:end"]);

  releaseFirst();
  await Promise.all([first, sibling]);
  assert.deepEqual(events, [
    "thread-one:start", "thread-three:start", "thread-three:end", "thread-one:end", "thread-two:start", "thread-two:end",
  ]);
});
