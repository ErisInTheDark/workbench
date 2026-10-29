/* No production exports. Protect shared stylesheet loading and skill-change cancellation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import ThreadComponentStylesController from "./thread-component-styles";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const style = { path: "skill", revision: "a".repeat(64), css: ".card{display:flex}" };

test("simultaneous cards share the active skill's stylesheet request", async () => {
  const pending = gate<readonly typeof style[]>();
  let calls = 0;
  const owner = new ThreadComponentStylesController(async () => { calls += 1; return await pending.promise; });
  owner.setSkills("skill", true);
  const first = owner.ensure([{ path: style.path, revision: style.revision }]);
  const second = owner.ensure([{ path: style.path, revision: style.revision }]);
  assert.equal(calls, 1);
  pending.resolve([style]);
  await Promise.all([first, second]);
  assert.deepEqual(owner.snapshot().styles, [style]);
});

test("a late stylesheet response cannot restore a deactivated skill", async () => {
  const pending = gate<readonly typeof style[]>();
  const owner = new ThreadComponentStylesController(async () => await pending.promise);
  owner.setSkills("skill", true);
  owner.setSkills("", false);
  pending.resolve([style]);
  await pending.promise;
  await Promise.resolve();
  assert.deepEqual(owner.snapshot().styles, []);
});

test("a newly rendered card refreshes changed active styles once", async () => {
  const updated = { ...style, revision: "b".repeat(64), css: ".card{display:grid}" };
  let calls = 0;
  const owner = new ThreadComponentStylesController(async () => [calls++ ? updated : style]);
  owner.setSkills("skill", true);
  await owner.ensure([{ path: style.path, revision: style.revision }]);
  await owner.ensure([{ path: updated.path, revision: updated.revision }]);
  await owner.ensure([{ path: updated.path, revision: updated.revision }]);
  assert.equal(calls, 2);
  assert.deepEqual(owner.snapshot().styles, [updated]);
});

test("stylesheet errors reach cards instead of silently displaying unstyled content", async () => {
  const owner = new ThreadComponentStylesController(async () => { throw new Error("style build failed"); });
  owner.setSkills("skill", true);
  await assert.rejects(owner.ensure([{ path: style.path, revision: style.revision }]), /style build failed/u);
  assert.equal(owner.snapshot().error, "style build failed");
});
