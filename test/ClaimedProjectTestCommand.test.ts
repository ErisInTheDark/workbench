/* No exports. Tests protect cwd/claim boundaries, list-only mode and failure propagation. */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ClaimedProjectTestCommand from "./ClaimedProjectTestCommand";

test("uses every live local claim without mixing repositories or launching list-only tests", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const claims = ["test/ProjectTestRunner.ts", "shared/workbench/git/git-arc-state.ts"];
  const selected: string[][] = [];
  const runs: string[][] = [];
  const requests: object[] = [];
  const output: string[] = [];
  let body: object | null = {
    repositoryScopes: [
      { repoRoot: root, claimedPaths: claims },
      { repoRoot: path.resolve(root, "../other"), claimedPaths: ["foreign.ts"] },
    ],
  };
  let status = 200;
  const options = {
    cwd: root,
    env: { WORKBENCH_ORIGIN: "http://127.0.0.1:4500", WORKBENCH_THREAD_ID: "test-thread", WORKBENCH_HARNESS: "codex" },
    fetch: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json(body, { status });
    }) as typeof fetch,
    output: (line: string) => { output.push(line); },
    select: async (paths: string[]) => {
      selected.push(paths);
      return { files: [path.join(root, "test/ProjectTestRunner.test.ts")], scopes: [], outsideSources: [] };
    },
    run: async (files: string[]) => { runs.push(files); return { exitCode: 7, signal: null }; },
  };
  const command = new ClaimedProjectTestCommand(root, options);
  assert.deepEqual(await command.run(["--list"]), { exitCode: 0, signal: null });
  assert.deepEqual(selected, [claims]);
  assert.equal(runs.length, 0);
  assert.equal(output.some(line => line.includes("other repositories")), true);
  assert.deepEqual(requests, [{ action: "arcScope", cwd: root, threadId: "test-thread", harness: "codex" }]);
  assert.deepEqual(await command.run([]), { exitCode: 7, signal: null });
  assert.equal(runs.length, 1);
  const before = requests.length;
  await assert.rejects(new ClaimedProjectTestCommand(root, { ...options, cwd: path.join(root, "test") }).run([]), /repository root/);
  await assert.rejects(new ClaimedProjectTestCommand(root, { ...options, env: { ...options.env, WORKBENCH_ORIGIN: "https://example.com" } }).run([]), /loopback/);
  assert.equal(requests.length, before);
  body = { repoRoot: root, claimedPaths: claims };
  await command.run(["--list"]);
  assert.deepEqual(selected.at(-1), claims);
  body = { repoRoot: root, claimedPaths: ["root:misleading.ts"], members: [] };
  await assert.rejects(command.run([]), /repository-relative/);
  body = null;
  await assert.rejects(command.run([]), /No live/);
  status = 503;
  await assert.rejects(command.run([]), /HTTP 503/);
  assert.equal(runs.length, 1);
});
