/* No exports. Protect arc tree loading: held paths read the daemon's view bytes and shape reads; outside agent threads or on failure the filesystem shows through. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import { publishDaemonEndpoint } from "../shared/process/workbench-daemon-endpoint";
import WorkbenchArcTree from "./WorkbenchArcTree.mjs";

const base64 = (text: string) => Buffer.from(text).toString("base64");

test("held paths read the daemon's view bytes, and the filesystem shows through without one", async t => {
  const temporary = await WorkbenchTemporaryDirectory.create("arc-tree-load-");
  t.after(() => temporary.dispose());
  const root = path.join(temporary.path, "repo");
  const data = path.join(temporary.path, "data");
  await fs.mkdir(root);
  // Another thread's live edits on disk: one change, one new file, one deletion.
  await fs.writeFile(path.join(root, "changed.txt"), "live\n");
  await fs.writeFile(path.join(root, "created.txt"), "new\n");
  await fs.writeFile(path.join(root, "plain.txt"), "plain\n");
  await publishDaemonEndpoint(path.join(data, "daemon/runtime.json"), {
    version: 1, pid: 1, instanceId: "00000000-0000-4000-8000-000000000001", origin: "http://127.0.0.1:4500",
  });

  const tree = "a".repeat(40);
  let body: unknown = { repositories: [{
    baseline: tree, head: null, held: [{ paths: ["changed.txt", "created.txt", "deleted.txt"], threadId: "other" }], repoRoot: root,
    contents: { "changed.txt": base64("baseline\n"), "created.txt": null, "deleted.txt": base64("kept\n") },
  }] };
  let status = 200;
  const requests: Array<{ action: string; contents: boolean; holdOwn: boolean }> = [];
  const warnings: string[] = [];
  const load = async (env: NodeJS.ProcessEnv) => await WorkbenchArcTree.load({
    cwd: root, env, warn: line => { warnings.push(line); },
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return status === 200 ? Response.json(body) : new Response("", { status });
    },
  });
  const caller = { WORKBENCH_DATA_ROOT: data, WORKBENCH_THREAD_ID: "caller" };

  const arc = await load(caller);
  assert.equal(arc.source, "arc", warnings.join("\n"));
  assert.deepEqual(requests.map(({ action, contents, holdOwn }) => [action, contents, holdOwn]), [["arcHeld", true, false]]);
  assert.equal(await arc.readFile("changed.txt", "utf8"), "baseline\n");
  assert.equal(await arc.readFile("deleted.txt", "utf8"), "kept\n");
  assert.equal(await arc.readFile("plain.txt", "utf8"), "plain\n");
  await assert.rejects(arc.readFile("created.txt"), { code: "ENOENT" });
  assert.deepEqual(["changed.txt", "created.txt", "deleted.txt"].map(name => arc.exists(name)), [true, false, true]);
  assert.deepEqual(arc.deletedOnDisk, [path.join(root, "deleted.txt")], "Node children cannot see restored deletions");

  const outside = await load({ WORKBENCH_DATA_ROOT: data });
  assert.equal(outside.source, "filesystem");
  assert.equal(requests.length, 1, "runs outside agent threads never ask the daemon");
  assert.equal(await outside.readFile("changed.txt", "utf8"), "live\n");

  status = 503;
  const failed = await load(caller);
  assert.equal(failed.source, "filesystem");
  assert.ok(failed.exists("created.txt"));
  assert.match(warnings.at(-1)!, /unavailable.*HTTP 503/u);

  status = 200;
  body = { repositories: [
    { repoRoot: root, baseline: "not a tree", held: [] },
    {
      head: null, repoRoot: root, baseline: tree,
      held: [{ paths: ["changed.txt", 7] }, { paths: ["changed.txt", 7, "created.txt", "plain.txt"], threadId: "other" }],
      contents: { "changed.txt": base64("baseline\n"), "created.txt": 7 },
    },
  ] };
  const repaired = await load(caller);
  assert.equal(repaired.source, "arc", "one malformed entry never discards the whole view");
  assert.deepEqual([...repaired.files.keys()], [path.join(root, "changed.txt")]);
  assert.equal(await repaired.readFile("created.txt", "utf8"), "new\n", "paths without readable view bytes read from disk");
  assert.match(warnings.at(-1)!, /dropped 5 malformed/u);
});
