/* No production exports. Protect env file drafts across opens, saves, failures and discards. */
import assert from "node:assert/strict";
import { test } from "node:test";
import EnvironmentFilesController from "./EnvironmentFilesController.ts";

function fixture(disk: Record<string, string>, stored: Record<string, string> = {}) {
  const drafts = new Map(Object.entries(stored));
  const saves: { path: string; content: string; settle(error?: Error): void }[] = [];
  const controller = new EnvironmentFilesController({
    listPaths: async () => Object.keys(disk),
    read: async path => ({ content: disk[path]!, mtimeMs: 1 }),
    save: (path, content) => new Promise((resolve, reject) => {
      saves.push({ path, content, settle: error => {
        if (error) return reject(error);
        disk[path] = content;
        resolve({ mtimeMs: 2 });
      } });
    }),
    drafts: {
      read: async path => drafts.get(path) ?? null,
      write: (path, draft) => { drafts.set(path, draft.content); },
      clear: async path => { drafts.delete(path); },
    },
  });
  const file = (path: string) => controller.getSnapshot().files.find(item => item.path === path)!;
  return { controller, drafts, saves, file };
}

test("stored drafts reopen dirty, while drafts matching disk are dropped", async () => {
  const { controller, drafts, file } = fixture({ ".env": "A=1", "app/.env.local": "B=1" }, { ".env": "A=2", "app/.env.local": "B=1" });
  await controller.discover();
  assert.deepEqual(controller.getSnapshot().files.map(item => [item.path, item.status]), [[".env", "idle"], ["app/.env.local", "idle"]]);
  await controller.open(".env");
  await controller.open("app/.env.local");
  assert.deepEqual([file(".env").content, file(".env").dirty], ["A=2", true]);
  assert.deepEqual([file("app/.env.local").content, file("app/.env.local").dirty], ["B=1", false]);
  assert.deepEqual([...drafts.keys()], [".env"]);
});

test("edits made during a save stay dirty with their draft", async () => {
  const { controller, drafts, saves, file } = fixture({ ".env": "A=1" });
  await controller.discover();
  await controller.open(".env");
  controller.edit(".env", "A=2");
  const saving = controller.save(".env");
  controller.edit(".env", "A=3");
  saves[0]!.settle();
  await saving;
  assert.deepEqual([file(".env").baseline, file(".env").content, file(".env").dirty], ["A=2", "A=3", true]);
  assert.equal(drafts.get(".env"), "A=3");
  const again = controller.save(".env");
  saves[1]!.settle();
  await again;
  assert.equal(file(".env").dirty, false);
  assert.equal(drafts.has(".env"), false);
});

test("failed saves keep the draft and discard restores disk content", async () => {
  const { controller, drafts, saves, file } = fixture({ ".env": "A=1" });
  await controller.discover();
  await controller.open(".env");
  controller.edit(".env", "A=2");
  const saving = controller.save(".env");
  saves[0]!.settle(new Error("disk full"));
  await saving;
  assert.deepEqual([file(".env").status, file(".env").error, file(".env").content], ["ready", "disk full", "A=2"]);
  assert.equal(drafts.get(".env"), "A=2");
  await controller.discard(".env");
  assert.deepEqual([file(".env").content, file(".env").dirty], ["A=1", false]);
  assert.equal(drafts.has(".env"), false);
});
