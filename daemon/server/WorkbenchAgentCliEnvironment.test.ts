/* No exports. Tests protect local test, checkout command, and bounded redirect dispatch with cwd isolation. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchAgentCliEnvironment from "./WorkbenchAgentCliEnvironment";

test("checkout handoffs preserve local redirect suppression until daemon dispatch", async context => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const temporary = await WorkbenchTemporaryDirectory.create("wb-redirect-");
  context.after(() => temporary.dispose());
  const checkout = path.join(temporary.path, "checkout");
  const shellRelativePath = "daemon/server/lib/workbench/cli/workbench-agent-cli.sh";
  const resolverRelativePath = "daemon/server/lib/workbench/cli/resolve-workbench-daemon-origin.mts";
  await mkdir(path.dirname(path.join(checkout, shellRelativePath)), { recursive: true });
  for (const relativePath of ["wb", shellRelativePath]) {
    await writeFile(path.join(checkout, relativePath), await readFile(path.join(repositoryRoot, relativePath)));
  }
  await writeFile(path.join(checkout, resolverRelativePath), "process.stdout.write(process.env.FIXTURE_ORIGIN);\n");
  const requests: URLSearchParams[] = [];
  let responseStatus = 200;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push(new URLSearchParams(body));
      response.writeHead(responseStatus);
      response.end("fixture-response\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  const entry = path.join(checkout, "wb");
  const localWrapper = [
    "#!/usr/bin/env bash",
    'visits="${FIXTURE_REDIRECT_VISITS:-0}"',
    'if (( visits >= 1 )); then printf "%s\\n" "fixture blocked repeated redirect" >&2; exit 91; fi',
    'export FIXTURE_REDIRECT_VISITS="$((visits + 1))"',
    'printf "%s\\n" visited >> "$FIXTURE_VISIT_LOG"',
    'exec bash "$FIXTURE_CHECKOUT/wb" "$@"',
    "",
  ].join("\n");
  for (const localPath of ["node_modules/.bin/wb", "daemon/node_modules/.bin/wb", "wb"]) {
    for (const redirected of [false, true]) {
      for (const status of [200, 503]) {
        await context.test(`${localPath}, redirected=${redirected}, status=${status}`, async () => {
          const project = path.join(temporary.path, `project-${localPath.replaceAll("/", "-")}-${redirected}-${status}`);
          const local = path.join(project, localPath);
          const log = path.join(project, "visits");
          await mkdir(path.dirname(local), { recursive: true });
          await writeFile(local, localWrapper);
          await writeFile(log, "");
          requests.length = 0;
          responseStatus = status;
          const args = ["store", "get", "key with spaces"];
          const invocation = promisify(execFile)("bash", [entry, ...args], {
            cwd: project,
            env: {
              ...process.env,
              WORKBENCH_CWD_REDIRECTED: redirected ? "1" : "",
              FIXTURE_REDIRECT_VISITS: "0",
              FIXTURE_CHECKOUT: checkout,
              FIXTURE_VISIT_LOG: log,
              FIXTURE_ORIGIN: `http://127.0.0.1:${address.port}`,
            },
          });
          if (status === 200) {
            const result = await invocation;
            assert.equal(result.stdout, "fixture-response\n");
            assert.equal(result.stderr, "");
          } else {
            await assert.rejects(invocation, error => {
              const failure = error as Error & { code: number; stdout: string; stderr: string };
              assert.equal(failure.code, 1);
              assert.equal(failure.stdout, "");
              assert.equal(failure.stderr, "fixture-response\n");
              return true;
            });
          }
          assert.equal(await readFile(log, "utf8"), redirected ? "" : "visited\n");
          assert.equal(requests.length, 1);
          assert.deepEqual(requests[0].getAll("arg"), args);
          // Git Bash reports Windows cwd using its POSIX drive spelling.
          const cwd = requests[0].get("cwd")!.replace(/^\/([a-z])\//iu, "$1:/");
          assert.equal(cwd.toLowerCase(), project.replaceAll("\\", "/").toLowerCase());
        });
      }
    }
  }
});

test("generated shims dispatch local tests only from their owning repository", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const cleanupTemporary = await WorkbenchTemporaryDirectory.create("wb-test-shim-");
  const temporary = cleanupTemporary.path;
  try {
    const installed = await new WorkbenchAgentCliEnvironment({
      resolverSourcePath: path.join(root, "daemon/server/lib/workbench/cli/resolve-workbench-daemon-origin.mts"),
      runtimeDirectoryPath: temporary,
      shellSourcePath: path.join(root, "daemon/server/lib/workbench/cli/workbench-agent-cli.sh"),
    }).install({});
    const invoke = (cwd: string) => promisify(execFile)("bash", [installed.posixShimPath, "test", "--help"], {
      cwd, env: { ...process.env, WORKBENCH_CWD_REDIRECTED: "1" },
    });
    assert.match((await invoke(root)).stdout, /wb test/);
    await assert.rejects(invoke(temporary), error => {
      assert.match((error as Error & { stderr: string }).stderr, /repository root/);
      return true;
    });
  } finally {
    await cleanupTemporary.dispose();
  }
});

test("generated shims dispatch ports through their owning checkout", async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const cleanupTemporary = await WorkbenchTemporaryDirectory.create("wb-ports-shim-");
  const root = cleanupTemporary.path;
  try {
    const shellSourcePath = path.join(root, "daemon/server/lib/workbench/cli/workbench-agent-cli.sh");
    const resolverSourcePath = path.join(root, "daemon/server/lib/workbench/cli/resolve-workbench-daemon-origin.mts");
    const checkoutCliPath = path.join(root, "cli/dispatch.mjs");
    await mkdir(path.dirname(shellSourcePath), { recursive: true });
    await mkdir(path.dirname(checkoutCliPath), { recursive: true });
    await writeFile(
      shellSourcePath,
      await readFile(path.join(repositoryRoot, "daemon/server/lib/workbench/cli/workbench-agent-cli.sh"), "utf8"),
    );
    await writeFile(checkoutCliPath, "process.stdout.write(`native:${process.argv.slice(2).join(' ')}\\n`);\n");
    const installed = await new WorkbenchAgentCliEnvironment({
      resolverSourcePath,
      runtimeDirectoryPath: path.join(root, "daemon/node_modules/.bin"),
      shellSourcePath,
    }).install({});

    const result = await promisify(execFile)("bash", [installed.posixShimPath, "ports"], {
      cwd: root,
      env: { ...process.env, WORKBENCH_THREAD_ID: "managed-thread" },
    });
    assert.equal(result.stdout, "native:ports\n");
    assert.equal(result.stderr, "");
  } finally {
    await cleanupTemporary.dispose();
  }
});
