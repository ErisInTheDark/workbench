/* No production exports. Regression wards cover durable reuse, in-flight coalescing, sliding expiry, and bounded LRU eviction without invoking Git. Keywords: proposal, cache, transcript, TTL, LRU, tests. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import GitArcProposalCache from "./GitArcProposalCache";

async function createCacheRoot(context: TestContext) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-proposal-cache-test-"));
  context.after(() => fs.rm(rootPath, { force: true, recursive: true }));
  return rootPath;
}

async function createTranscript(rootPath: string, harness: "codex" | "copilot" | "opencode", threadId: string) {
  const threadDirectory = path.join(
    rootPath,
    ".workbench",
    "transcripts",
    harness,
    "threads",
    Buffer.from(threadId, "utf8").toString("base64url"),
  );
  await fs.mkdir(threadDirectory, { recursive: true });
  await fs.writeFile(path.join(threadDirectory, "thread.json"), "{}\n");
}

test("reuses derived changes beneath the canonical harness transcript", async (context) => {
  const rootPath = await createCacheRoot(context);
  const threadId = "shared-thread-id";
  await createTranscript(rootPath, "opencode", threadId);
  const tree = "a".repeat(40);
  let builds = 0;
  const input = {
    baseTree: tree,
    build: async () => {
      builds += 1;
      return [];
    },
    harness: "opencode" as const,
    paths: ["one.txt"],
    proposalId: "proposal-one",
    rootPath,
    targetTree: tree,
    threadId,
  };
  const cache = new GitArcProposalCache();
  await cache.readOrBuild(input);
  await cache.readOrBuild(input);
  assert.equal(builds, 1);
});

test("coalesces misses and extends its idle TTL without transcript storage", async (context) => {
  const rootPath = await createCacheRoot(context);
  const tree = "a".repeat(40);
  let builds = 0;
  let now = 0;
  let releaseBuild: () => void = () => undefined;
  let reportBuildStarted: () => void = () => undefined;
  const buildStarted = new Promise<void>((resolve) => { reportBuildStarted = resolve; });
  const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
  const cache = new GitArcProposalCache({ memoryTtlMs: 10, now: () => now });
  const input = {
    baseTree: tree,
    build: async () => {
      builds += 1;
      if (builds === 1) {
        reportBuildStarted();
        await buildGate;
      }
      return [];
    },
    harness: "codex" as const,
    paths: ["one.txt"],
    proposalId: "memory-proposal",
    rootPath,
    targetTree: tree,
    threadId: "thread-without-transcript",
  };

  const first = cache.readOrBuild(input);
  const duplicate = cache.readOrBuild(input);
  await buildStarted;
  assert.equal(builds, 1);
  releaseBuild();
  await Promise.all([first, duplicate]);

  now = 9;
  await cache.readOrBuild(input);
  now = 18;
  await cache.readOrBuild(input);
  assert.equal(builds, 1);
  now = 29;
  await cache.readOrBuild(input);
  assert.equal(builds, 2);
});

test("evicts the least recently used immutable snapshot", async (context) => {
  const rootPath = await createCacheRoot(context);
  const tree = "a".repeat(40);
  const builds = new Map<string, number>();
  const cache = new GitArcProposalCache({ maxMemoryEntries: 2, memoryTtlMs: 1_000, now: () => 0 });
  const read = async (proposalId: string, targetTree: string) => await cache.readOrBuild({
    baseTree: tree,
    build: async () => {
      builds.set(proposalId, (builds.get(proposalId) ?? 0) + 1);
      return [];
    },
    harness: "codex",
    paths: ["one.txt"],
    proposalId,
    rootPath,
    targetTree,
    threadId: "thread-without-transcript",
  });

  await read("proposal-one", "1".repeat(40));
  await read("proposal-two", "2".repeat(40));
  await read("proposal-one", "1".repeat(40));
  await read("proposal-three", "3".repeat(40));
  await read("proposal-two", "2".repeat(40));

  assert.equal(builds.get("proposal-one"), 1);
  assert.equal(builds.get("proposal-two"), 2);
  assert.equal(builds.get("proposal-three"), 1);
});
