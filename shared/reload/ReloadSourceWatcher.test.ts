/*
 * No production exports. Tests protect source-only observation, directory recovery and subscription disposal.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { type FSWatcher, type watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ReloadSourceWatcher, { type ReloadSourceWatchScope } from "./ReloadSourceWatcher.ts";

async function fixture(context: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-source-watcher-"));
  for (const directory of ["src/nested", "src/generated", ".git/objects", ".workbench/tmp", "node_modules/unused"]) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  let scopes: ReloadSourceWatchScope[] = [{ paths: [], patterns: ["src/**/*.ts", "src/*.ts", "!src/generated/**", "!**/*.test.ts"] }];
  const handles = new Map<string, {
    emitter: EventEmitter;
    notify(event: string, filename: string | null): void;
  }>();
  let onChange = () => {};
  let changes = 0;
  const errors: Error[] = [];
  const watcher = new ReloadSourceWatcher({
    root,
    getScopes: () => scopes,
    onChange: () => { changes++; onChange(); },
    onError: error => errors.push(error),
    watchSource: ((directory, _options, listener) => {
      const relative = path.relative(root, String(directory)).replaceAll("\\", "/");
      const emitter = new EventEmitter();
      const handle = { emitter, notify: listener as (event: string, filename: string | null) => void };
      handles.set(relative, handle);
      return Object.assign(emitter, {
        close() { if (handles.get(relative) === handle) handles.delete(relative); },
      }) as FSWatcher;
    }) as typeof watch,
  });
  context.after(async () => {
    watcher.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await watcher.refresh();
  return {
    root, watcher, handles, errors,
    get changes() { return changes; },
    setScopes(next: ReloadSourceWatchScope[]) { scopes = next; },
    async notify(directory: string, event: string, filename: string | null) {
      const changed = new Promise<void>(resolve => { onChange = resolve; });
      const handle = handles.get(directory);
      assert.ok(handle, `source directory ${directory} must remain observable`);
      handle.notify(event, filename);
      await changed;
    },
  };
}

test("source coverage excludes internal and generated trees while admitting new source directories", async context => {
  const target = await fixture(context);
  for (const directory of [".git", ".workbench", "node_modules", "src/generated"]) {
    assert.equal(target.handles.has(directory), false, `${directory} must not contribute recursive source events`);
  }
  const before = target.changes;
  target.handles.get("src")!.notify("change", "ignored.test.ts");
  target.handles.get("")!.notify("change", ".git");
  target.handles.get("")!.notify("change", "src");
  await target.watcher.refresh();
  assert.equal(target.changes, before);

  await fs.mkdir(path.join(target.root, "src", "new"));
  await fs.writeFile(path.join(target.root, "src", "new", "owner.ts"), "source");
  await target.notify("src", "rename", "new");
  await target.notify("src/new", "change", "owner.ts");
  assert.equal(target.changes, before + 2);
});

test("ordered source patterns can reinclude a subtree beneath an excluded directory", async context => {
  const target = await fixture(context);
  await fs.mkdir(path.join(target.root, "src/generated/handwritten"), { recursive: true });
  target.setScopes([{
    paths: [],
    patterns: ["src/**", "!src/generated/**", "src/generated/handwritten/**"],
  }]);
  await target.watcher.refresh();
  await target.notify("src/generated/handwritten", "change", "owner.ts");
  assert.equal(target.changes, 1);
});

test("directory replacement and filename-less events restore coverage without losing later edits", async context => {
  const target = await fixture(context);
  const original = target.handles.get("src/nested");
  await fs.rm(path.join(target.root, "src", "nested"), { recursive: true });
  await fs.mkdir(path.join(target.root, "src", "nested"));
  await target.notify("src", "rename", "nested");
  assert.notEqual(target.handles.get("src/nested"), original);
  await target.notify("src/nested", "change", "recreated.ts");

  await fs.mkdir(path.join(target.root, "src", "recovered"));
  await target.notify("src", "change", null);
  await target.notify("src/recovered", "change", "owner.ts");
  assert.deepEqual(target.errors, []);
});

test("dynamic source coverage and watcher failures remain lifecycle-owned", async context => {
  const target = await fixture(context);
  target.setScopes([{ paths: [".workbench/marker"], patterns: [] }]);
  await target.watcher.refresh();
  assert.equal(target.handles.has("src"), false);
  assert.equal(target.handles.has(".workbench/tmp"), false);
  await target.notify(".workbench", "change", "marker");

  const error = new Error("watch subscription failed");
  const handle = target.handles.get(".workbench")!;
  handle.emitter.emit("error", error);
  assert.deepEqual(target.errors, [error]);
  const changes = target.changes;
  target.watcher.close();
  assert.equal(target.handles.size, 0);
  handle.notify("change", "marker");
  handle.emitter.emit("error", new Error("late retired error"));
  await target.watcher.refresh();
  assert.equal(target.changes, changes);
  assert.equal(target.handles.size, 0);
});
