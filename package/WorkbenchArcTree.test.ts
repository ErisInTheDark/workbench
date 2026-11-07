/* No exports. Protect arc tree loading: held paths read the daemon's view bytes and shape reads; outside agent threads or on failure the filesystem shows through. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import { publishDaemonEndpoint } from "../shared/process/workbench-daemon-endpoint";
import WorkbenchArcTree from "./WorkbenchArcTree.mjs";

const base64 = (text: string) => Buffer.from(text).toString("base64");

test("only held paths that differ from disk warn, capped per thread, and never under hold-own", async t => {
  const temporary = await WorkbenchTemporaryDirectory.create("arc-tree-mixed-");
  t.after(() => temporary.dispose());
  const root = path.join(temporary.path, "repo");
  const data = path.join(temporary.path, "data");
  await fs.mkdir(root);
  await publishDaemonEndpoint(path.join(data, "daemon/runtime.json"), {
    version: 1, pid: 1, instanceId: "00000000-0000-4000-8000-000000000001", origin: "http://127.0.0.1:4500",
  });
  await fs.writeFile(path.join(root, "same.txt"), "same\n");
  const moved = Array.from({ length: 7 }, (_, index) => `moved-${index}.txt`);
  await Promise.all(moved.map(name => fs.writeFile(path.join(root, name), "live\n")));
  const body = { repositories: [{
    baseline: "a".repeat(40), head: null, repoRoot: root,
    held: [{ paths: moved, threadId: "busy" }, { paths: ["same.txt"], threadId: "quiet" }],
    contents: { ...Object.fromEntries(moved.map(name => [name, base64("baseline\n")])), "same.txt": base64("same\n") },
  }] };
  const load = async (options: { holdOwn?: boolean; warn?: (line: string) => void }) => await WorkbenchArcTree.load({
    ...options, cwd: root, env: { WORKBENCH_DATA_ROOT: data, WORKBENCH_THREAD_ID: "caller" },
    fetch: async () => Response.json(body),
  });
  const warnings: string[] = [];
  await load({ warn: line => { warnings.push(line); } });
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0]!, /7 of 8 held paths differ from disk/u);
  assert.match(warnings[0]!, /thread busy: 7 differ: moved-0\.txt, moved-1\.txt, moved-2\.txt, moved-3\.txt, moved-4\.txt \(\+2 more\)/u);
  assert.doesNotMatch(warnings[0]!, /quiet|same\.txt/u, "holds matching disk mix nothing");
  warnings.length = 0;
  await load({ holdOwn: true, warn: line => { warnings.push(line); } });
  assert.deepEqual(warnings, [], "a hold-own view is the tree the caller asked for");
});

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
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0]!, /3 of 3 held paths differ from disk/u);
  assert.match(warnings[0]!, /thread other: 3 differ, 1 absent here: changed\.txt, created\.txt, deleted\.txt/u);
  warnings.length = 0;

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
  assert.ok(warnings.some(line => /dropped 5 malformed/u.test(line)), warnings.join("\n"));
});
