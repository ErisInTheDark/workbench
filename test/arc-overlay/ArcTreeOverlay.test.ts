/* No exports. Protect arc overlay loading: held paths come from the daemon's tree; outside agent threads or on failure nothing is overlaid. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import WorkbenchTemporaryDirectory from "../../shared/WorkbenchTemporaryDirectory";
import { publishDaemonEndpoint } from "../../shared/process/workbench-daemon-endpoint";
import ArcTreeOverlay from "./ArcTreeOverlay";

test("loads other threads' held paths from the caller's arc tree, and nothing without one", async t => {
  const temporary = await WorkbenchTemporaryDirectory.create("arc-overlay-load-");
  t.after(() => temporary.dispose());
  const root = path.join(temporary.path, "repo");
  const data = path.join(temporary.path, "data");
  await fs.mkdir(root);
  const git = async (...args: string[]) => (await promisify(execFile)("git", args, { cwd: root })).stdout.trim();
  await git("init", "--quiet");
  await git("config", "core.autocrlf", "false");
  await fs.writeFile(path.join(root, "changed.txt"), "baseline\n");
  await fs.writeFile(path.join(root, "deleted.txt"), "kept\n");
  await git("add", ".");
  await git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "base");
  const tree = await git("rev-parse", "HEAD^{tree}");
  // Another thread's live edits: one change, one new file, one deletion.
  await fs.writeFile(path.join(root, "changed.txt"), "live\n");
  await fs.writeFile(path.join(root, "created.txt"), "new\n");
  await fs.rm(path.join(root, "deleted.txt"));
  await publishDaemonEndpoint(path.join(data, "daemon/runtime.json"), {
    version: 1, pid: 1, instanceId: "00000000-0000-4000-8000-000000000001", origin: "http://127.0.0.1:4500",
  });

  let response = Response.json({ repositories: [{
    head: null, held: [{ paths: ["changed.txt", "created.txt", "deleted.txt"], threadId: "other" }], repoRoot: root, tree,
  }] });
  const requests: Array<{ action: string; holdOwn: boolean }> = [];
  const output: string[] = [];
  const load = async (env: NodeJS.ProcessEnv) => await ArcTreeOverlay.load({
    env, root, output: line => { output.push(line); },
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return response.clone();
    },
  });
  const caller = { WORKBENCH_DATA_ROOT: data, WORKBENCH_THREAD_ID: "caller" };

  const overlay = await load(caller);
  assert.ok(overlay, output.join("\n"));
  assert.deepEqual(
    [...overlay.files].map(([target, content]) => [path.relative(root, target), content?.toString() ?? null]).sort(),
    [["changed.txt", "baseline\n"], ["created.txt", null], ["deleted.txt", "kept\n"]],
  );
  assert.deepEqual(requests.map(({ action, holdOwn }) => [action, holdOwn]), [["arcTree", false]]);
  assert.match(output.at(-1)!, /deleted\.txt/u, "tests cannot restore deletions, so the run says which");

  assert.equal(await load({ WORKBENCH_DATA_ROOT: data }), null);
  assert.equal(requests.length, 1, "runs outside agent threads never ask the daemon");

  response = new Response("", { status: 503 });
  assert.equal(await load(caller), null);
  assert.match(output.at(-1)!, /unavailable.*HTTP 503/u);
});
