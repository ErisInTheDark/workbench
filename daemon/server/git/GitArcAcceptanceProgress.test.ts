import assert from "node:assert/strict";
import test from "node:test";
import GitArcAcceptanceProgress, { type GitArcAcceptance } from "./GitArcAcceptanceProgress";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("acceptance progress never waits on publication and publishes the newest fact before finishing", async () => {
  const progress = new GitArcAcceptanceProgress();
  const published: GitArcAcceptance[] = [];
  const releases: Array<() => void> = [];
  let called = deferred();
  progress.start("owner", ["one", "two", "three"], async acceptance => {
    published.push(acceptance);
    const release = deferred();
    releases.push(release.resolve);
    called.resolve();
    await release.promise;
  });
  assert.throws(() => progress.start("owner", ["four"], async () => undefined), /already committing/u);

  progress.advance("owner", "one");
  progress.advance("owner", "two");
  progress.advance("owner", "three");
  assert.deepEqual(published, [{ landingId: "two", queuedIds: ["three"] }], "a burst behind a slow publication waits for it");
  assert.deepEqual(progress.read("owner"), { landingId: null, queuedIds: [] });

  let finished = false;
  const finishing = progress.finish("owner").then(() => { finished = true; });
  called = deferred();
  releases.shift()!();
  await called.promise;
  assert.deepEqual(published.at(-1), { landingId: null, queuedIds: [] }, "the burst folds into the newest fact");
  assert.equal(published.length, 2);
  assert.equal(finished, false, "finishing waits for the last publication");
  releases.shift()!();
  await finishing;
  assert.equal(progress.read("owner"), null);
});
