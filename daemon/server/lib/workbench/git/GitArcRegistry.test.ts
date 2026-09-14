/*
 * Exports: none. Tests protect canonical Git arc ownership, orphan hiding, and raw-row preservation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import GitArcRegistry, { REGISTRY_REF, type GitArcRegistryEntry } from "./GitArcRegistry";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";
import type { GitArcThreadIdentityResolver } from "./git-arc-thread-identity";

function entry(threadId: string, claimedPaths: string[]): GitArcRegistryEntry {
  return {
    checkpointCommit: threadId.padEnd(40, "0").slice(0, 40),
    claimedPaths,
    harness: "codex",
    intentDescription: "",
    intentName: threadId,
    phase: "active",
    proposalId: null,
    proposalIds: [],
    retainedArc: null,
    threadId,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function input(threadId: string, claimedPaths: string[]): Omit<GitArcRegistryEntry, "updatedAt"> {
  const { updatedAt: _updatedAt, ...value } = entry(threadId, claimedPaths);
  return value;
}

function fixture(entries: GitArcRegistryEntry[]) {
  const written = new Map<string, string>();
  const resolutions: string[] = [];
  let nextBlob = 0;
  const repository = {
    root: "C:/repo",
    readBlobAtRef: async (ref: string) => ref === REGISTRY_REF
      ? { blob: "a".repeat(40), contents: `${JSON.stringify({ entries, version: 1 })}\n` }
      : null,
    writeBlob: async (contents: string) => {
      const blob = String(++nextBlob).padStart(40, "b");
      written.set(blob, contents);
      return blob;
    },
  } as unknown as WorkbenchGitRepository;
  const resolve: GitArcThreadIdentityResolver = async ({ threadId }) => {
    resolutions.push(threadId);
    if (threadId === "provider-owner" || threadId === "wb-owner") {
      return { nativeThreadId: "provider-owner", threadId: "wb-owner" };
    }
    if (threadId === "provider-new" || threadId === "wb-new") {
      return { nativeThreadId: "provider-new", threadId: "wb-new" };
    }
    return null;
  };
  return { registry: new GitArcRegistry(repository, resolve), resolutions, written };
}

test("registry projects mapped owners while hiding orphan rows from live ownership", async () => {
  const { registry } = fixture([
    entry("provider-owner", ["owned.ts"]),
    entry("orphan-owner", ["orphan.ts"]),
  ]);

  assert.deepEqual((await registry.list()).map(({ threadId }) => threadId), ["wb-owner"]);
  assert.equal((await registry.find({ harness: "codex", threadId: "provider-owner" }))?.threadId, "wb-owner");
  assert.equal(await registry.find({ harness: "codex", threadId: "orphan-owner" }), null);
});

test("mutations reuse canonical rows while preserving aliases, remaps, ordering and guards", async (context) => {
  const owner = entry("provider-owner", []);
  const alias = entry("wb-owner", []);
  const sibling = entry("provider-new", ["sibling.ts"]);
  sibling.retainedArc = {
    checkpointCommit: sibling.checkpointCommit,
    claimedPaths: ["retained.ts"],
    intentDescription: "",
    intentName: "retained",
    phase: "active",
    proposalIds: [],
  };
  const orphan = entry("orphan-owner", ["orphan.ts"]);
  const rows = [owner, alias, sibling, orphan];
  const remapped = "c".repeat(40);
  for (const operation of ["claim", "set", "release"] as const) {
    await context.test(operation, async () => {
      const { registry, resolutions, written } = fixture(rows);
      const mutation = operation === "claim"
        ? await registry.prepareClaim(input("wb-owner", ["new.ts"]), {
          expectedCheckpointCommit: owner.checkpointCommit,
          commitRemaps: new Map([[sibling.checkpointCommit, remapped]]),
        })
        : operation === "set"
          ? await registry.prepareSet(input("wb-owner", ["new.ts"]), owner.checkpointCommit)
          : await registry.prepareRelease({ harness: "codex", threadId: "wb-owner" }, {
            expectedCheckpointCommit: owner.checkpointCommit,
            commitRemaps: new Map([[sibling.checkpointCommit, remapped]]),
          });
      assert.ok(mutation);
      const update = mutation.updates.find(update => update.ref === REGISTRY_REF)!;
      assert.equal(update.oldValue, "a".repeat(40), "publication retains the original CAS boundary");
      const stored = JSON.parse(written.get(update.newValue)!) as { entries: GitArcRegistryEntry[] };
      assert.equal(stored.entries.some(row => row.threadId === "provider-owner"), false);
      assert.equal(stored.entries.filter(row => row.threadId === "wb-owner").length, operation === "release" ? 0 : 1);
      assert.deepEqual(stored.entries.find(row => row.threadId === "orphan-owner"), orphan);
      assert.deepEqual(
        mutation.nextState.entries,
        stored.entries.filter(row => row.threadId !== "orphan-owner").map(row => ({
          ...row,
          threadId: row.threadId === "provider-new" ? "wb-new" : row.threadId,
        })),
        "returned canonical projection follows persisted raw-row order",
      );
      const returnedSibling = mutation.nextState.entries.find(row => row.threadId === "wb-new")!;
      assert.equal(returnedSibling.checkpointCommit, operation === "set" ? sibling.checkpointCommit : remapped);
      assert.equal(returnedSibling.retainedArc?.checkpointCommit, operation === "set" ? sibling.checkpointCommit : remapped);
      assert.equal(resolutions.filter(id => id === "provider-new").length, 1, "existing sibling is resolved once");
      assert.equal(resolutions.filter(id => id === "orphan-owner").length, 1, "orphan is resolved once");
      assert.equal(resolutions.filter(id => id === "provider-owner").length, 1);
      assert.equal(resolutions.filter(id => id === "wb-owner").length, 2, "input and existing alias each resolve once");
    });
  }
  const { registry, written } = fixture(rows);
  await assert.rejects(registry.prepareClaim(input("wb-owner", ["new.ts"]), { expectedCheckpointCommit: "stale" }), /changed/u);
  await assert.rejects(registry.prepareSet(input("wb-owner", ["new.ts"]), "stale"), /changed/u);
  await assert.rejects(registry.prepareRelease({ harness: "codex", threadId: "wb-owner" }, { expectedCheckpointCommit: "stale" }), /changed/u);
  assert.equal(written.size, 0, "stale ownership never prepares publication");
  await assert.rejects(registry.prepareClaim(input("wb-owner", ["sibling.ts"]), {
    expectedCheckpointCommit: owner.checkpointCommit,
  }), /overlap/u);
  assert.equal(written.size, 0, "canonical sibling collisions still block claims");
});

test("unrelated claims ignore and preserve orphan rows while writing the canonical WB owner", async () => {
  const orphan = entry("orphan-owner", ["shared.ts"]);
  const mapped = entry("provider-owner", ["owned.ts"]);
  const { registry, written } = fixture([mapped, orphan]);

  const mutation = await registry.prepareClaim(input("provider-new", ["shared.ts"]));
  const contents = written.get(mutation.updates[0]!.newValue)!;
  const stored = JSON.parse(contents) as { entries: GitArcRegistryEntry[] };

  assert.deepEqual(stored.entries.map(({ threadId }) => threadId).sort(), [
    "orphan-owner",
    "provider-owner",
    "wb-new",
  ]);
  assert.deepEqual(stored.entries.find(({ threadId }) => threadId === "orphan-owner"), orphan);
});

test("replacing a mapped provider row removes its alias and writes only the canonical WB owner", async () => {
  const { registry, written } = fixture([entry("provider-owner", ["old.ts"])]);
  const mutation = await registry.prepareSet(input("provider-owner", ["new.ts"]));
  const contents = written.get(mutation.updates[0]!.newValue)!;
  const stored = JSON.parse(contents) as { entries: GitArcRegistryEntry[] };

  assert.deepEqual(stored.entries.map(({ threadId }) => threadId), ["wb-owner"]);
  assert.deepEqual(stored.entries[0]?.claimedPaths, ["new.ts"]);
});
