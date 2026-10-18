/* No exports. Tests protect launcher staging, exact argv delivery from agent shells, checkout redirects and local test/ports dispatch. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

import { verifyNativeSidecarArtifact } from "workbench-shared/native/native-sidecar-artifact";
import NativeArtifactStage from "workbench-shared/process/NativeArtifactStage";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchAgentCliEnvironment, { WORKBENCH_LAUNCHER_ARTIFACT } from "./WorkbenchAgentCliEnvironment";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const platformLauncher = process.platform === "win32" ? "windows-x64/wb.exe" : "linux-x64/wb";

async function daemonFixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-launcher-");
  context.after(() => temporary.dispose());
  const received: URLSearchParams[] = [];
  const endpoint = { version: 1 as const, instanceId: "00000000-0000-4000-8000-000000000001", pid: process.pid, origin: "" };
  const server = http.createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(endpoint));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      received.push(new URLSearchParams(body));
      response.writeHead(200);
      response.end("ok\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  endpoint.origin = `http://127.0.0.1:${address.port}`;
  const dataRoot = path.join(temporary.path, "data");
  await mkdir(path.join(dataRoot, "daemon"), { recursive: true });
  await writeFile(path.join(dataRoot, "daemon", "runtime.json"), JSON.stringify(endpoint));
  return { dataRoot, received, temporary: temporary.path };
}

async function installFixture(temporary: string, dataRoot: string, legacyShimDirectoryPath = path.join(temporary, "legacy")) {
  const warnings: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, WORKBENCH_DATA_ROOT: dataRoot, WORKBENCH_CWD_REDIRECTED: "" };
  const installed = await new WorkbenchAgentCliEnvironment({
    checkoutRoot: repositoryRoot,
    legacyShimDirectoryPath,
    stage: new NativeArtifactStage({ runtimeRoot: path.join(temporary, "runtime") }),
    warn: message => warnings.push(message),
  }).install(env);
  return { env, installed, warnings };
}

/** A checkout layout around a copy of the published launcher, with a fixture `cli/dispatch.mjs`. */
async function checkoutFixture(root: string, label: string) {
  const launcher = path.join(root, "daemon/launcher/bin", platformLauncher);
  await mkdir(path.dirname(launcher), { recursive: true });
  await copyFile(await verifyNativeSidecarArtifact(repositoryRoot, WORKBENCH_LAUNCHER_ARTIFACT), launcher);
  await mkdir(path.join(root, "cli"), { recursive: true });
  await writeFile(path.join(root, "cli/dispatch.mjs"), `process.stdout.write(\`${label}:\${process.argv.slice(2).join(" ")}\\n\`);\n`);
  return launcher;
}

test("install stages the launcher outside the checkout, puts it first on PATH and retires only managed shims", async context => {
  const { dataRoot, temporary } = await daemonFixture(context);
  const legacy = path.join(temporary, "legacy");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "wb"), "#!/usr/bin/env bash\n# workbench-agent-cli-shim-v1\n");
  await writeFile(path.join(legacy, "wb.cmd"), "@rem workbench-agent-cli-shim-v1\r\n");
  await writeFile(path.join(legacy, "wb.ps1"), "# someone else's wb\n");
  const { env, installed } = await installFixture(temporary, dataRoot, legacy);

  assert.equal(path.dirname(installed.launcherPath), path.join(temporary, "runtime", "native", "launcher"));
  assert.deepEqual(
    await readFile(installed.launcherPath),
    await readFile(await verifyNativeSidecarArtifact(repositoryRoot, WORKBENCH_LAUNCHER_ARTIFACT)),
  );
  assert.equal(env.PATH?.split(path.delimiter)[0], path.dirname(installed.launcherPath));
  assert.equal(env.WORKBENCH_CHECKOUT_ROOT, repositoryRoot);
  await assert.rejects(readFile(path.join(legacy, "wb")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(legacy, "wb.cmd")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(legacy, "wb.ps1"), "utf8"), "# someone else's wb\n");
});

test("agent shells deliver wb argv exactly", async context => {
  const { dataRoot, received, temporary } = await daemonFixture(context);
  const { env } = await installFixture(temporary, dataRoot);
  const quoted = ['{"a":"b|c"}', "line one\nline two", "^x", "100%PATH%", "it's", "*.ts", "a & b", "trailing\\", "", "ünï"];
  const expected = ["tokens", ...quoted.slice(0, 5), "--", ...quoted.slice(5)];
  if (process.platform === "win32") {
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const script = `wb tokens ${quoted.slice(0, 5).map(literal).join(" ")} -- ${quoted.slice(5).map(literal).join(" ")}`;
    await execFileAsync("pwsh", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { cwd: temporary, env });
  } else {
    await execFileAsync("bash", ["-c", 'wb "$@"', "wb", ...expected], { cwd: temporary, env });
  }
  assert.deepEqual(received.map(form => form.getAll("arg")), [expected]);
});

test("piped vis output and hook input travel as their own fields", async context => {
  const { dataRoot, received, temporary } = await daemonFixture(context);
  const { installed, env } = await installFixture(temporary, dataRoot);
  for (const [args, extra] of [[["vis", "render", "--run", "r1"], {}], [[], { WORKBENCH_APPLY_PATCH_CLAIM_HOOK: "1" }]] as const) {
    const child = execFile(installed.launcherPath, [...args], { cwd: temporary, env: { ...env, ...extra } });
    child.stdin!.end("piped\nbody");
    await new Promise<void>((resolve, reject) => child.once("exit", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  }
  assert.equal(received[0]!.get("stdin"), "piped\nbody");
  assert.deepEqual(received[1]!.getAll("arg"), ["__hook", "apply-patch-claim"]);
  assert.equal(received[1]!.get("hookInput"), "piped\nbody");
});

test("wb inside another checkout runs that checkout's launcher once", async context => {
  const { dataRoot, temporary } = await daemonFixture(context);
  const { installed, env } = await installFixture(temporary, dataRoot);
  const other = path.join(temporary, "other-checkout");
  await checkoutFixture(other, "other");
  const redirected = await execFileAsync(installed.launcherPath, ["ports"], { cwd: other, env });
  assert.equal(redirected.stdout, "other:ports\n");
  // A redirected launcher keeps its own checkout instead of redirecting again.
  await assert.rejects(
    execFileAsync(installed.launcherPath, ["ports"], { cwd: other, env: { ...env, WORKBENCH_CWD_REDIRECTED: "1", WORKBENCH_CHECKOUT_ROOT: temporary } }),
    (error: Error & { stderr: string }) => /checkout CLI is unavailable/u.test(error.stderr),
  );
});

test("local tests dispatch only from the owning checkout root", async context => {
  const { dataRoot, temporary } = await daemonFixture(context);
  const { installed, env } = await installFixture(temporary, dataRoot);
  assert.match((await execFileAsync(installed.launcherPath, ["test", "--help"], { cwd: repositoryRoot, env })).stdout, /wb test/u);
  await assert.rejects(
    execFileAsync(installed.launcherPath, ["test", "--help"], { cwd: temporary, env }),
    (error: Error & { stderr: string }) => /repository root/u.test(error.stderr),
  );
});
