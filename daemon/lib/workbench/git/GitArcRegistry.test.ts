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
    if (threadId === "provider-owner" || threadId === "wb-owner") {
      return { nativeThreadId: "provider-owner", threadId: "wb-owner" };
    }
    if (threadId === "provider-new" || threadId === "wb-new") {
      return { nativeThreadId: "provider-new", threadId: "wb-new" };
    }
    return null;
  };
  return { registry: new GitArcRegistry(repository, resolve), written };
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
