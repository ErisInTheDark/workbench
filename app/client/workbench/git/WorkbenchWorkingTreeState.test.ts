/* No production exports. Protect selection freshness, coalesced reads and disposal. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkingTreeRead } from "workbench-shared/workbench/git/working-tree-contracts";
import WorkbenchWorkingTreeState from "./WorkbenchWorkingTreeState";

const repositoryData = (): WorkingTreeRead => ({ errors: [], repositories: [{
  rootId: "r", label: "repo", cwd: "/repo", head: "a".repeat(40), tree: "b".repeat(40), branch: "main",
  message: "old message", amendReason: null, blockedReason: null, owners: [], files: [],
}] });

test("operation failure survives a successful refresh and is not retried", async () => {
  let mutations = 0;
  const state = new WorkbenchWorkingTreeState("project", {
    read: async () => repositoryData(),
    diff: async request => ({ identity: request.identity, patch: "", unavailable: null }),
    preview: async request => ({ identity: request.identity, before: null, after: null, encoding: "text", mime: "text/plain", unavailable: null }),
    mutate: async () => { mutations++; throw new Error("publication rejected"); },
  });
  await state.refresh();
  state.setMode("amend");
  await state.submit();
  assert.match(state.getSnapshot().operationError, /publication rejected/);
  assert.equal(mutations, 1);
  state.dispose();
});

test("an inaccessible sibling root does not block a successfully inspected repository", async () => {
  const data = repositoryData();
  data.errors = [{ rootId: "other", message: "other root unavailable" }];
  let mutations = 0;
  const state = new WorkbenchWorkingTreeState("project", {
    read: async () => structuredClone(data),
    diff: async request => ({ identity: request.identity, patch: "", unavailable: null }),
    preview: async request => ({ identity: request.identity, before: null, after: null, encoding: "text", mime: "text/plain", unavailable: null }),
    mutate: async () => { mutations++; return { status: "complete", commit: null, stash: null, message: "", warnings: [] }; },
  });
  await state.refresh();
  state.setMode("amend");
  await state.submit();
  assert.equal(mutations, 1);
  assert.match(state.getSnapshot().error, /unavailable/);
  state.dispose();
});

test("amend drafts keep their reviewed target when HEAD changes", async () => {
  const data = repositoryData();
  let mutations = 0;
  const state = new WorkbenchWorkingTreeState("project", {
    read: async () => structuredClone(data),
    diff: async request => ({ identity: request.identity, patch: "", unavailable: null }),
    preview: async request => ({ identity: request.identity, before: null, after: null, encoding: "text", mime: "text/plain", unavailable: null }),
    mutate: async () => { mutations++; return { status: "complete", commit: null, stash: null, message: "", warnings: [] }; },
  });
  await state.refresh();
  state.setMode("amend");
  state.setDraft({ title: "edited message" });
  data.repositories[0]!.head = "c".repeat(40);
  await state.refresh();
  await state.submit();
  assert.equal(mutations, 0);
  assert.equal(state.getSnapshot().draft.title, "edited message");
  assert.match(state.getSnapshot().operationError, /HEAD/);
  state.dispose();
});

test("effect reactivation fences retired reads and starts a fresh single reader", async () => {
  const reads: ((data: WorkingTreeRead) => void)[] = [];
  const state = new WorkbenchWorkingTreeState("project", {
    read: () => new Promise(resolve => reads.push(resolve)),
    diff: async request => ({ identity: request.identity, patch: "", unavailable: null }),
    preview: async request => ({ identity: request.identity, before: null, after: null, encoding: "text", mime: "text/plain", unavailable: null }),
    mutate: async () => ({ status: "complete", commit: null, stash: null, message: "", warnings: [] }),
  });
  const retired = state.refresh();
  state.dispose();
  state.activate();
  const current = state.refresh();
  reads[0]!({ errors: [], repositories: [] });
  await retired;
  assert.equal(reads.length, 2);
  reads[1]!(repositoryData());
  await current;
  assert.equal(state.repository?.rootId, "r");
  state.dispose();
});

test("refresh retains review state and blocks every mutation until its fresh result arrives", async () => {
  const data = repositoryData();
  let resolveRead!: (data: WorkingTreeRead) => void;
  let mutations = 0;
  let readCount = 0;
  const state = new WorkbenchWorkingTreeState("project", {
    read: async () => ++readCount === 2 ? await new Promise(resolve => { resolveRead = resolve; }) : structuredClone(data),
    diff: async request => ({ identity: request.identity, patch: "", unavailable: null }),
    preview: async request => ({ identity: request.identity, before: null, after: null, encoding: "text", mime: "text/plain", unavailable: null }),
    mutate: async () => {
      mutations++;
      return { status: "complete", commit: null, stash: null, message: "", warnings: [] };
    },
  });
  await state.refresh();
  state.setMode("amend");
  const oldRead = state.refresh();
  assert.equal(state.getSnapshot().refreshing, true);
  assert.equal(state.repository?.head, data.repositories[0]!.head);
  for (const mode of ["commit", "amend", "stash", "discard"] as const) await state.submit(mode);
  assert.equal(mutations, 0);
  data.repositories[0]!.head = "c".repeat(40);
  resolveRead(structuredClone(data));
  await oldRead;
  assert.equal(state.repository?.head, "c".repeat(40));
  assert.equal(state.getSnapshot().refreshing, false);
  state.reviewHead();
  await state.submit();
  assert.equal(mutations, 1);
  assert.equal(readCount, 3);
  state.dispose();
});

test("opening uses cached review while a fresh scan runs and a failed refresh preserves it", async () => {
  const data = repositoryData();
  let finish!: (data: WorkingTreeRead) => void;
  let fail!: (error: Error) => void;
  let entered!: () => void;
  const freshStarted = new Promise<void>(resolve => { entered = resolve; });
  const requests: { preferCached?: boolean }[] = [];
  const state = new WorkbenchWorkingTreeState("project", {
    read: request => {
      requests.push(request);
      if (request.preferCached) return Promise.resolve({ ...structuredClone(data), cacheHit: true });
      entered();
      return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    },
    diff: async request => ({ identity: request.identity, patch: "", unavailable: null }),
    preview: async request => ({ identity: request.identity, before: null, after: null, encoding: "text", mime: "text/plain", unavailable: null }),
    mutate: async () => ({ status: "complete", commit: null, stash: null, message: "", warnings: [] }),
  });
  const opening = state.refresh();
  assert.equal(requests[0]?.preferCached, true);
  await freshStarted;
  assert.equal(state.repository?.head, data.repositories[0]!.head);
  assert.equal(state.getSnapshot().initialising, false);
  assert.equal(state.getSnapshot().refreshing, true);
  finish(structuredClone(data));
  await opening;
  state.setDraft({ title: "keep this draft" });
  const refresh = state.refresh();
  fail(new Error("scan unavailable"));
  await refresh;
  assert.equal(state.repository?.head, data.repositories[0]!.head);
  assert.equal(state.getSnapshot().draft.title, "keep this draft");
  assert.equal(state.getSnapshot().refreshing, false);
  assert.equal(state.getSnapshot().status, "error");
  const recovery = state.refresh();
  finish(structuredClone(data));
  await recovery;
  assert.equal(state.getSnapshot().status, "ready");
  state.dispose();
});

test("refreshes coalesce and changed/claimed files lose selection without accepting retired reads", async () => {
  const data: WorkingTreeRead = { errors: [], repositories: [{
    rootId: "r", label: "repo", cwd: "/repo", head: "a".repeat(40), tree: "b".repeat(40), branch: "main",
    message: "previous\n\nbody", amendReason: null, blockedReason: null, owners: [],
    files: [{ path: "a", oldPath: null, identity: "one", status: "M", baseBlob: null, blob: null,
      mode: "100644", baseMode: "100644", partial: true, binary: false, additions: 1, deletions: 1, ownerIds: [] }],
  }] };
  let finish!: (result: WorkingTreeRead) => void;
  let reads = 0;
  const state = new WorkbenchWorkingTreeState("project", {
    read: async () => { reads++; return await new Promise(resolve => { finish = resolve; }); },
    diff: async request => ({ identity: request.identity, patch: "", unavailable: null }),
    preview: async request => ({ identity: request.identity, before: null, after: null, encoding: "text", mime: "text/plain", unavailable: null }),
    mutate: async () => ({ status: "complete", commit: null, stash: null, message: "done", warnings: [] }),
  });
  const first = state.refresh();
  const duplicate = state.refresh();
  finish(structuredClone(data));
  await Promise.all([first, duplicate]);
  assert.equal(reads, 1);
  assert.equal(state.getSnapshot().selections.length, 1);
  const next = state.refresh();
  data.repositories[0]!.files[0]!.ownerIds = ["thread"];
  finish(structuredClone(data));
  await next;
  assert.equal(state.getSnapshot().selections.length, 0);
  const retired = state.refresh();
  state.dispose();
  finish({ repositories: [], errors: [] });
  await retired;
  assert.equal(state.getSnapshot().data.repositories.length, 1);
});

test("preview readers coalesce and a later file cannot receive an old preview", async () => {
  const data = repositoryData();
  data.repositories[0]!.files = [{
    path: "a.png", oldPath: null, identity: "image", status: "M", baseBlob: null, blob: null,
    mode: "100644", baseMode: "100644", partial: false, binary: true, additions: null, deletions: null, ownerIds: [],
  }];
  const finish: (() => void)[] = [];
  const state = new WorkbenchWorkingTreeState("project", {
    read: async () => structuredClone(data),
    diff: async request => ({ identity: request.identity, patch: "", unavailable: "binary" }),
    preview: async request => {
      await new Promise<void>(resolve => finish.push(resolve));
      return { identity: request.identity, before: null, after: "", encoding: "base64", mime: "image/png", unavailable: null };
    },
    mutate: async () => ({ status: "complete", commit: null, stash: null, message: "", warnings: [] }),
  });
  await state.refresh();
  const first = state.loadPreview();
  const second = state.loadPreview();
  state.selectFile("no longer selected");
  finish.forEach(resolve => resolve());
  await Promise.all([first, second]);
  assert.equal(finish.length, 1);
  assert.equal(state.getSnapshot().preview, null);
  state.dispose();
});

test("initial unclaimed files are included, exclusions survive refresh and root switches", async () => {
  const data = repositoryData();
  const root = data.repositories[0]!;
  root.files = ["a", "b", "claimed"].map(path => ({
    path, oldPath: null, identity: path, status: "M", baseBlob: null, blob: null,
    mode: "100644", baseMode: "100644", partial: true, binary: false, additions: 1, deletions: 1,
    ownerIds: path === "claimed" ? ["owner"] : [],
  }));
  data.repositories.push({ ...structuredClone(root), rootId: "other", cwd: "/other" });
  const state = new WorkbenchWorkingTreeState("project", {
    read: async () => structuredClone(data),
    diff: async request => ({ identity: request.identity, patch: "", unavailable: null }),
    preview: async request => ({ identity: request.identity, before: null, after: "", encoding: "text", mime: "text/plain", unavailable: null }),
    mutate: async () => ({ status: "complete", commit: null, stash: null, message: "", warnings: [] }),
  });
  await state.refresh();
  assert.deepEqual(state.getSnapshot().selections.map(file => file.path), ["a", "b"]);
  state.toggleFile("a");
  await state.refresh();
  assert.deepEqual(state.getSnapshot().selections.map(file => file.path), ["b"]);
  state.selectRoot("other");
  assert.deepEqual(state.getSnapshot().selections.map(file => file.path), ["a", "b"]);
  state.selectRoot("r");
  assert.deepEqual(state.getSnapshot().selections.map(file => file.path), ["b"]);
  root.files.push({ ...root.files[0]!, path: "new", identity: "new" });
  root.files[1]!.identity = "edited";
  await state.refresh();
  assert.deepEqual(state.getSnapshot().selections.map(file => file.path), ["new"]);
  state.dispose();
});

test("revisiting an unchanged file immediately reuses content while changed identities load anew", async () => {
  const data = repositoryData();
  data.repositories[0]!.files = ["a", "b"].map(path => ({
    path, oldPath: null, identity: path, status: "M", baseBlob: null, blob: null,
    mode: "100644", baseMode: "100644", partial: true, binary: false, additions: 1, deletions: 1, ownerIds: [],
  }));
  let calls = 0;
  const state = new WorkbenchWorkingTreeState("project", {
    read: async () => structuredClone(data),
    diff: async request => { calls++; return { identity: request.identity, patch: request.path, unavailable: null }; },
    preview: async request => ({ identity: request.identity, before: null, after: "", encoding: "text", mime: "text/plain", unavailable: null }),
    mutate: async () => ({ status: "complete", commit: null, stash: null, message: "", warnings: [] }),
  });
  await state.refresh();
  state.selectFile("b");
  await state.loadContent();
  state.selectFile("a");
  assert.equal(state.getSnapshot().contentStatus, "ready");
  assert.equal(state.getSnapshot().diff?.patch, "a");
  assert.equal(calls, 2);
  data.repositories[0]!.files[0]!.identity = "changed";
  await state.refresh();
  assert.equal(calls, 3);
  assert.equal(state.getSnapshot().diff?.identity, "changed");
  assert.equal(state.getSnapshot().selections.some(selection => selection.path === "a"), false);
  state.dispose();
});

test("a failed root scan keeps its prior review but cannot authorise mutations", async () => {
  let data = repositoryData();
  const state = new WorkbenchWorkingTreeState("project", {
    read: async () => structuredClone(data),
    diff: async request => ({ identity: request.identity, patch: "", unavailable: null }),
    preview: async request => ({ identity: request.identity, before: null, after: null, encoding: "text", mime: "text/plain", unavailable: null }),
    mutate: async () => { throw new Error("must remain blocked"); },
  });
  await state.refresh();
  data = { repositories: [], errors: [{ rootId: "r", message: "repository unavailable" }] };
  await state.refresh();
  assert.equal(state.repository?.head, "a".repeat(40));
  assert.equal(state.mutationBlocked, true);
  assert.match(state.getSnapshot().error, /repository unavailable/);
  state.dispose();
});
