/* No production exports. Protect store row autosave ordering, diffing and unreadable values. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectStoreSnapshot } from "workbench-shared/workbench/project/project-store";
import { InputListRows } from "../../components/workbench/input-list-rows.ts";
import ProjectStoreRowsController from "./ProjectStoreRowsController.ts";

type Update = { upserts: { key: string; value: string }[]; removals: string[]; settle(error?: Error): void };

function fixture(snapshot: ProjectStoreSnapshot) {
  const updates: Update[] = [];
  const controller = new ProjectStoreRowsController({
    read: async () => snapshot,
    update: (upserts, removals) => new Promise<void>((resolve, reject) => {
      updates.push({ upserts, removals, settle: error => error ? reject(error) : resolve() });
    }),
  });
  const rowFor = (key: string) => controller.getSnapshot().rows.find(row => row.key === key)!;
  const edit = (id: string, patch: { key?: string; value?: string }) =>
    controller.setRows(InputListRows.edit(controller.getSnapshot().rows, id, patch));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { controller, updates, rowFor, edit, flush };
}

test("edits made during a save are sent after it and never replaced by its acknowledgement", async () => {
  const { controller, updates, rowFor, edit, flush } = fixture({ entries: [{ key: "A", value: "1" }] });
  await controller.load();
  edit(rowFor("A").id, { value: "2" });
  edit(rowFor("A").id, { value: "3" });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]!.upserts, [{ key: "A", value: "2" }]);
  updates[0]!.settle();
  await flush();
  assert.equal(rowFor("A").value, "3");
  assert.deepEqual(updates[1]!.upserts, [{ key: "A", value: "3" }]);
  updates[1]!.settle();
  await flush();
  assert.equal(controller.getSnapshot().status, "ready");
  assert.equal(updates.length, 2);
});

test("renames and deletions save; incomplete or duplicate rows never remove stored keys", async () => {
  const { controller, updates, rowFor, edit, flush } = fixture({ entries: [{ key: "A", value: "1" }, { key: "B", value: "2" }] });
  await controller.load();
  edit(rowFor("A").id, { key: "B" });
  assert.equal(updates.length, 0);
  assert.equal(Object.keys(controller.getSnapshot().issues).length, 2);
  edit(rowFor("B").id, { key: "C" });
  assert.deepEqual({ upserts: updates[0]!.upserts, removals: updates[0]!.removals }, { upserts: [{ key: "C", value: "1" }], removals: ["A"] });
  updates[0]!.settle();
  await flush();
  const blank = controller.getSnapshot().rows.at(-1)!;
  edit(blank.id, { value: "orphan" });
  assert.equal(updates.length, 1);
  assert.deepEqual([...controller.getSnapshot().savedKeys!].sort(), ["B", "C"]);
});

test("unreadable values stay stored until replaced, and failed saves retry with the latest rows", async () => {
  const { controller, updates, rowFor, edit, flush } = fixture({ entries: [{ key: "OLD", unreadable: true }, { key: "A", value: "1" }] });
  await controller.load();
  assert.match(controller.getSnapshot().issues[rowFor("OLD").id]!, /cannot be decrypted/);
  edit(rowFor("A").id, { value: "2" });
  assert.deepEqual({ upserts: updates[0]!.upserts, removals: updates[0]!.removals }, { upserts: [{ key: "A", value: "2" }], removals: [] });
  updates[0]!.settle(new Error("offline"));
  await flush();
  assert.equal(controller.getSnapshot().status, "failed");
  assert.equal(rowFor("A").value, "2");
  edit(rowFor("OLD").id, { value: "fresh" });
  assert.deepEqual(updates[1]!.upserts, [{ key: "OLD", value: "fresh" }, { key: "A", value: "2" }]);
  assert.equal(controller.getSnapshot().issues[rowFor("OLD").id], undefined);
});
