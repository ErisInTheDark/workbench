/*
 * No production exports. Tests protect turn liveness publication: started turns read live, ended turns publish not live, idle threads never ask the provider.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import WorkbenchThreadTurnLiveness from "./WorkbenchThreadTurnLiveness";

function setup() {
  const running = new Map<string, string>();
  const published: Array<[string, boolean]> = [];
  let providerReads = 0;
  const liveness = new WorkbenchThreadTurnLiveness({
    threads: () => ({
      latestTurn: async threadId => {
        providerReads += 1;
        return { id: running.get(threadId) ?? "ended" } as Turn;
      },
      isTurnLive: async (threadId, turnId) => running.get(threadId) === turnId,
    }),
    resolveHarness: async () => "claude",
    publish: (threadId, turnLive) => { published.push([threadId, turnLive]); },
    warn: () => {},
  });
  return { liveness, running, published, providerReads: () => providerReads };
}

test("a started turn publishes live, and the commit after it ends publishes not live", async () => {
  const { liveness, running, published } = setup();
  running.set("thread", "turn");
  await liveness.turnStarted("thread");
  await liveness.settled(["thread"]);
  assert.deepEqual(published, [["thread", true]], "commits while the turn runs change nothing");

  running.delete("thread");
  await liveness.settled(["thread"]);
  assert.deepEqual(published, [["thread", true], ["thread", false]]);
});

test("commits for threads not known to be live never ask the provider", async () => {
  const { liveness, providerReads } = setup();
  assert.equal(await liveness.read("thread", "claude"), false);
  const before = providerReads();
  await liveness.settled(["thread", "other"]);
  assert.equal(providerReads(), before);
});

test("a read that finds a live turn is rechecked once it ends", async () => {
  const { liveness, running, published } = setup();
  running.set("thread", "turn");
  assert.equal(await liveness.read("thread", "claude"), true);
  running.delete("thread");
  await liveness.settled(["thread"]);
  assert.deepEqual(published, [["thread", false]]);
});
