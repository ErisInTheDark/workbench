/* No production exports. Protect object reviews focusing a real file and never showing a superseded file's diff. */
import assert from "node:assert/strict";
import test from "node:test";
import type { GitObjectDetail } from "workbench-shared/workbench/git/git-object-contracts";
import GitContentCache from "./GitContentCache";
import WorkbenchGitObjectState from "./WorkbenchGitObjectState";

const sha = "a".repeat(40);
const file = (path: string) => ({
  path, oldPath: null, status: "M" as const, baseBlob: null, blob: null, baseMode: "100644", mode: "100644",
  identity: path, additions: 1, deletions: 0, binary: false,
});
const detail: GitObjectDetail = {
  object: { kind: "commit", sha }, parents: [], subject: "s", body: "", author: "a", authoredAt: 0,
  undoBlocked: null, threads: [], files: [file("a.ts"), file("b.ts")],
};
const preview = async () => ({ identity: "", before: null, after: null, encoding: "text" as const, mime: "text/plain", unavailable: null });

test("a requested file the object lacks falls back to its first file", async () => {
  const state = new WorkbenchGitObjectState({ daemonId: null, projectId: "p" }, { kind: "commit", sha }, {
    read: async () => detail, diff: async input => ({ identity: input.path, patch: input.path, unavailable: null }), preview,
  }, "gone.ts", new GitContentCache());
  await state.load();
  assert.equal(state.getSnapshot().path, "a.ts");
  assert.equal(state.getSnapshot().diff?.patch, "a.ts");
});

test("switching files drops the earlier file's late diff", async () => {
  const gates = new Map<string, () => void>();
  const state = new WorkbenchGitObjectState({ daemonId: null, projectId: "p" }, { kind: "commit", sha }, {
    read: async () => detail,
    diff: async input => {
      await new Promise<void>(resolve => gates.set(input.path, resolve));
      return { identity: input.path, patch: input.path, unavailable: null };
    },
    preview,
  }, null, new GitContentCache());
  const loading = state.load();
  await new Promise(resolve => setImmediate(resolve));
  state.selectFile("b.ts");
  gates.get("b.ts")!();
  await new Promise(resolve => setImmediate(resolve));
  gates.get("a.ts")!();
  await loading;
  assert.equal(state.getSnapshot().path, "b.ts");
  assert.equal(state.getSnapshot().diff?.patch, "b.ts");
});
