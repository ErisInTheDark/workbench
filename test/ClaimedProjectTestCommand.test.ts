/* No exports. Tests protect claim/explicit-input boundaries, previews and failure propagation. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ClaimedProjectTestCommand from "./ClaimedProjectTestCommand";
import { publishDaemonEndpoint } from "../shared/process/workbench-daemon-endpoint";

test("automatic selection discovers current endpoint publications without inherited origins", async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const data = await mkdtemp(path.join(os.tmpdir(), "claimed-test-endpoint-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const endpoint = path.join(data, "daemon/runtime.json");
  const origins: string[] = [];
  const env: NodeJS.ProcessEnv = { WORKBENCH_DATA_ROOT: data, WORKBENCH_THREAD_ID: "test-thread" };
  let runs = 0;
  const command = new ClaimedProjectTestCommand(root, {
    cwd: root, env, output: () => undefined,
    fetch: async url => {
      origins.push(new URL(String(url)).origin);
      return Response.json({ repoRoot: root, claimedPaths: ["test/ClaimedProjectTestCommand.ts"] });
    },
    select: async () => ({ files: ["test/ClaimedProjectTestCommand.test.ts"], scopes: [], outsideSources: [] }),
    run: async () => { runs++; return { exitCode: 0, signal: null }; },
  });
  await mkdir(path.dirname(endpoint), { recursive: true });
  await assert.rejects(command.run([]), /daemon.*endpoint/i);
  assert.equal(origins.length, 0);
  for (const port of [4500, 4501]) {
    await publishDaemonEndpoint(endpoint, {
      version: 1, pid: 1, instanceId: "00000000-0000-4000-8000-000000000001", origin: `http://127.0.0.1:${port}`,
    });
    await command.run([]);
    env.WORKBENCH_ORIGIN = "http://127.0.0.1:9999";
  }
  assert.deepEqual(origins, ["http://127.0.0.1:4500", "http://127.0.0.1:4501"]);
  await writeFile(endpoint, JSON.stringify({ version: 1, origin: "https://example.com" }));
  await assert.rejects(command.run([]), /endpoint.*invalid/i);
  assert.equal(origins.length, 2);
  assert.equal(runs, 2);
  await command.run(["--help"]);
  await command.run(["--", "test/ClaimedProjectTestCommand.test.ts"]);
  assert.equal(origins.length, 2);
  assert.equal(runs, 3);
});

test("uses every live local claim without mixing repositories or launching list-only tests", async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const data = await mkdtemp(path.join(os.tmpdir(), "claimed-test-selection-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await publishDaemonEndpoint(path.join(data, "daemon/runtime.json"), {
    version: 1, pid: 1, instanceId: "00000000-0000-4000-8000-000000000001", origin: "http://127.0.0.1:4500",
  });
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
    env: { WORKBENCH_DATA_ROOT: data, WORKBENCH_THREAD_ID: "test-thread", WORKBENCH_HARNESS: "codex" },
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

  const explicit = new ClaimedProjectTestCommand(root, { ...options, env: {} });
  const requestsBeforeExplicit = requests.length;
  const selectionsBeforeExplicit = selected.length;
  const files = ["test/ProjectTestRunner.test.ts", "test/ProjectTestCatalog.test.ts"];
  assert.deepEqual(await explicit.run(["--", ...files]), { exitCode: 7, signal: null });
  assert.deepEqual(runs.at(-1), files);
  await explicit.run(["--"]);
  assert.deepEqual(runs.at(-1), []);
  const runsBeforeList = runs.length;
  await explicit.run(["--list", "--", ...files, files[0]]);
  assert.deepEqual(output.at(-1)?.split("\n").sort(), files.map(file => path.normalize(file)).sort());
  assert.equal(runs.length, runsBeforeList);
  assert.equal(requests.length, requestsBeforeExplicit);
  assert.equal(selected.length, selectionsBeforeExplicit);
  await assert.rejects(explicit.run(["--", "--invalid-option"]), /Unknown test runner option/);
  await assert.rejects(new ClaimedProjectTestCommand(root, { ...options, cwd: path.join(root, "test") }).run(["--", ...files]), /repository root/);
});
