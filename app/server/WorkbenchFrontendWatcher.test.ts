/*
 * No production exports. Tests protect native rebuild admission, trailing changes, failures and retirement.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type parcelWatcher from "@parcel/watcher";

import WorkbenchFrontendWatcher from "./WorkbenchFrontendWatcher.ts";

function fixture() {
  const root = path.resolve("frontend-watcher-fixture");
  const callbacks = new Map<string, parcelWatcher.SubscribeCallback>();
  const errors: Error[] = [];
  let rebuilds = 0;
  let rebuild: () => Promise<void> = async () => {};
  let completed = Promise.withResolvers<void>();
  const watcher = new WorkbenchFrontendWatcher({
    root,
    outputs: [path.join(root, "output")],
    subscribe: async (directory, callback) => {
      callbacks.set(directory, callback);
      return { async unsubscribe() { callbacks.delete(directory); } };
    },
    rebuild: async () => { rebuilds++; await rebuild(); completed.resolve(); },
    onError: error => { errors.push(error); completed.resolve(); },
  });
  return {
    root, watcher, callbacks, errors,
    get rebuilds() { return rebuilds; },
    setRebuild(next: () => Promise<void>) { rebuild = next; },
    event(relative: string, type: parcelWatcher.EventType = "update") {
      callbacks.get(root)?.(null, [{ path: path.join(root, relative), type }]);
    },
    completion() { completed = Promise.withResolvers<void>(); return completed.promise; },
  };
}

test("native events rebuild sources and missing imports but ignore output and repository churn", async context => {
  const target = fixture();
  context.after(() => target.watcher.close());
  await target.watcher.start();
  for (const ignored of [".git/objects/object", ".workbench/runtime.json", "output/assets/app.js", "docs/note.md"]) target.event(ignored);
  assert.equal(target.rebuilds, 1);

  const completion = target.completion();
  target.event("app/client/new-import.ts", "create");
  await completion;
  assert.equal(target.rebuilds, 2);
});

test("changes during a rebuild collapse into one trailing rebuild and retirement drops queued work", async context => {
  const target = fixture();
  context.after(() => target.watcher.close());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  target.setRebuild(async () => { entered.resolve(); await release.promise; });
  const starting = target.watcher.start();
  await entered.promise;
  for (let index = 0; index < 10; index++) target.event("shared/source.ts");
  release.resolve();
  await starting;
  assert.equal(target.rebuilds, 2);

  const enteredAgain = Promise.withResolvers<void>();
  const releaseAgain = Promise.withResolvers<void>();
  target.setRebuild(async () => { enteredAgain.resolve(); await releaseAgain.promise; });
  const completed = target.completion();
  target.event("app/client/source.ts");
  await enteredAgain.promise;
  target.event("app/client/source.ts");
  await target.watcher.close();
  releaseAgain.resolve();
  await completed;
  assert.equal(target.rebuilds, 3);
  assert.equal(target.callbacks.size, 0);
});

test("failed rebuilds retain event-driven recovery and watcher errors are surfaced", async context => {
  const target = fixture();
  context.after(() => target.watcher.close());
  await target.watcher.start();
  const failure = new Error("missing import");
  target.setRebuild(async () => { throw failure; });
  const failed = target.completion();
  target.event("app/client/source.ts");
  await failed;
  assert.deepEqual(target.errors, [failure]);

  target.setRebuild(async () => {});
  const recovered = target.completion();
  target.event("app/client/missing.ts", "create");
  await recovered;
  assert.equal(target.rebuilds, 3);
  const watcherFailure = new Error("native watcher failed");
  target.callbacks.get(target.root)!(watcherFailure, []);
  assert.deepEqual(target.errors, [failure, watcherFailure]);
});

test("retirement closes a subscription that finishes attaching late", async () => {
  const subscribed = Promise.withResolvers<parcelWatcher.AsyncSubscription>();
  let closed = false;
  let rebuilt = false;
  const watcher = new WorkbenchFrontendWatcher({
    root: process.cwd(), outputs: [],
    subscribe: async () => await subscribed.promise,
    rebuild: async () => { rebuilt = true; },
    onError: error => { throw error; },
  });
  const starting = watcher.start();
  await watcher.close();
  subscribed.resolve({ async unsubscribe() { closed = true; } });
  await starting;
  assert.equal(closed, true);
  assert.equal(rebuilt, false);
});

test("external dependency directory deletion triggers recovery and retired inputs release their subscriptions", async context => {
  const external = await mkdtemp(path.join(os.tmpdir(), "workbench-external-input-"));
  const target = fixture();
  context.after(async () => {
    await target.watcher.close();
    await rm(external, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  });
  await target.watcher.start();
  await target.watcher.updateDependencies([path.join(external, "dependency.ts")], [], true);
  const callback = target.callbacks.get(external);
  assert.ok(callback);
  callback(null, [{ path: external, type: "delete" }]);
  assert.equal(target.rebuilds, 2, "deleting an input's containing directory must wake the compiler");
  await target.watcher.updateDependencies([], [], false);
  assert.ok(target.callbacks.has(external), "a failed build must retain recovery coverage");
  await target.watcher.updateDependencies([], [], true);
  assert.equal(target.callbacks.has(external), false);
});
