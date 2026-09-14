/*
 * Exports: none. Tests protect immutable proposal diff reuse, bounded build admission, failure semantics, and disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { GitCheckpointFileChange } from "workbench-shared/workbench/git/checkpoint-contracts";
import GitArcProposalDiffController, {
  type GitArcProposalDiffCacheInput,
  type GitArcProposalDiffStore,
} from "./GitArcProposalDiffController";

const changes: GitCheckpointFileChange[] = [{
  additions: 1,
  deletions: 0,
  diff: "diff --git a/src/file.ts b/src/file.ts\n",
  kind: { move_path: null, type: "update" },
  path: "src/file.ts",
}];

function input(targetTree: string, build: GitArcProposalDiffCacheInput["build"]): GitArcProposalDiffCacheInput {
  return {
    baseTree: "a".repeat(40),
    build,
    paths: ["src/file.ts"],
    repositoryRoot: "C:/Git/Project",
    targetTree,
  };
}

function storeFixture() {
  const values = new Map<string, GitCheckpointFileChange[]>();
  const reads: string[] = [];
  const writes: Array<{ key: string; maxBytes: number }> = [];
  const store: GitArcProposalDiffStore = {
    read: async value => {
      reads.push(value.key);
      return values.get(value.key) ?? null;
    },
    write: async (value, maxBytes) => {
      writes.push({ key: value.key, maxBytes });
      values.set(value.key, value.changes);
    },
  };
  return { reads, store, values, writes };
}

test("an immutable store hit avoids Git and completed values have no controller memory cache", async () => {
  const fixture = storeFixture();
  let builds = 0;
  const controller = new GitArcProposalDiffController({ maxStoredBytes: 123, store: fixture.store });
  const request = input("b".repeat(40), async () => {
    builds += 1;
    return changes;
  });

  const first = await controller.readOrBuild(request);
  assert.deepEqual(first, changes);
  assert.equal(builds, 1);
  assert.equal(fixture.writes[0]?.maxBytes, 123);
  const second = await controller.readOrBuild(request);
  assert.deepEqual(second, changes);
  assert.equal(builds, 1);
  assert.equal(fixture.reads.length, 2);
  controller.dispose();
});

test("identical misses coalesce while distinct builds admit at most two in FIFO order", async () => {
  const fixture = storeFixture();
  const controller = new GitArcProposalDiffController({ maxConcurrentBuilds: 2, store: fixture.store });
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  const build = (name: string) => async () => {
    starts.push(name);
    await new Promise<void>(resolve => releases.set(name, resolve));
    return changes;
  };

  const first = controller.readOrBuild(input("1".repeat(40), build("first")));
  const duplicate = controller.readOrBuild(input("1".repeat(40), build("duplicate")));
  const second = controller.readOrBuild(input("2".repeat(40), build("second")));
  const third = controller.readOrBuild(input("3".repeat(40), build("third")));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(starts, ["first", "second"]);

  releases.get("first")!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(starts, ["first", "second", "third"]);
  releases.get("second")!();
  releases.get("third")!();
  assert.deepEqual(await Promise.all([first, duplicate, second, third]), [changes, changes, changes, changes]);
  assert.ok(!starts.includes("duplicate"));
  controller.dispose();
});

test("cache failures warn and fall back while Git failures still reject", async () => {
  const warnings: string[] = [];
  const controller = new GitArcProposalDiffController({
    onWarning: message => warnings.push(message),
    store: {
      read: async () => { throw new Error("sqlite read broke"); },
      write: async () => { throw new Error("sqlite write broke"); },
    },
  });
  assert.deepEqual(await controller.readOrBuild(input("4".repeat(40), async () => changes)), changes);
  assert.deepEqual(warnings.map(message => message.includes("sqlite")), [true, true]);
  await assert.rejects(
    controller.readOrBuild(input("5".repeat(40), async () => { throw new Error("git broke"); })),
    /git broke/u,
  );
  controller.dispose();
});

test("disposal rejects queued work and aborts active builds", async () => {
  const fixture = storeFixture();
  const controller = new GitArcProposalDiffController({ maxConcurrentBuilds: 1, store: fixture.store });
  let activeSignal: AbortSignal | null = null;
  const active = controller.readOrBuild(input("6".repeat(40), async signal => {
    activeSignal = signal;
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return changes;
  }));
  const queued = controller.readOrBuild(input("7".repeat(40), async () => changes));
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.dispose();
  assert.equal(activeSignal?.aborted, true);
  await assert.rejects(active, /disposed/u);
  await assert.rejects(queued, /disposed/u);
});
