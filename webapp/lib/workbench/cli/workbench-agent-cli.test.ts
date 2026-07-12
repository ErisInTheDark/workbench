/*
 * Exports:
 * - No production exports; Node tests cover wb parsing, transport, and generated shims. Keywords: workbench, cli, test, shim, allowlist.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import WorkbenchAgentCliEnvironment from "../../../orchestrator/WorkbenchAgentCliEnvironment.ts";
import WorkbenchAgentCli from "./WorkbenchAgentCli.ts";
import {
  parseWorkbenchAgentCliCommand,
  type WorkbenchAgentCliRequest,
} from "./workbench-agent-cli-commands.ts";
import { adaptWorkbenchAgentCliResponse } from "./workbench-agent-cli-responses.ts";

const execFileAsync = promisify(execFile);
const cliEntryPath = fileURLToPath(new URL("./WorkbenchAgentCli.ts", import.meta.url));
const requests: Array<{ body: string; method: string; url: string }> = [];
let origin = "";
let server: http.Server;
let temporaryDirectoryPath = "";
let reloadStatusReadCount = 0;

before(async () => {
  server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ body, method: request.method ?? "", url: request.url ?? "" });
      if (request.url === "/api/orchestrator/reload") {
        if (request.method === "GET") {
          reloadStatusReadCount += 1;
          if (reloadStatusReadCount === 1) {
            request.socket.destroy();
            return;
          }
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ appliedScopes: ["codex-bridge"], completedAt: Date.now(), error: null, ok: true, queuedScopes: ["next-dev"], requestedScopes: ["codex-bridge", "next-dev"], startedAt: 1, state: "succeeded" }));
          return;
        }
        response.writeHead(202, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ appliedScopes: [], completedAt: null, error: null, ok: true, queuedScopes: [], requestedScopes: [], startedAt: 1, state: "running" }));
        return;
      }
      response.writeHead(request.url?.includes("failure") ? 400 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ method: request.method, ok: true, url: request.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), "workbench-agent-cli-test-"));
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(temporaryDirectoryPath, { recursive: true, force: true });
});

test("parses fixed thread, checkpoint, and Browse requests with cwd ownership", async () => {
  const title = await parseWorkbenchAgentCliCommand([
    "thread", "title", "--thread", "thread/1", "--harness", "codex", "--title", "A title",
  ], { cwd: "C:/workspace" });
  assert.equal(title.kind, "request");
  assert.deepEqual(title.request, {
    body: { harness: "codex", threadId: "thread/1", title: "A title" },
    method: "POST",
    path: "/api/thread-title",
    responseKind: "thread-title",
  });

  const recall = await parseWorkbenchAgentCliCommand(["thread", "recall", "--thread", "thread/1", "--before", "user:item-1"]);
  const context = await parseWorkbenchAgentCliCommand(["thread", "context", "--thread", "thread/1", "--before", "user:item-1"]);
  assert.equal(recall.kind, "request");
  assert.equal(context.kind, "request");
  assert.deepEqual(context.request, recall.request);
  assert.equal(recall.request.path, "/api/thread-context/thread%2F1?before=user%3Aitem-1");

  const search = await parseWorkbenchAgentCliCommand([
    "thread", "recall", "search", "--thread", "thread/1", "--query", "normal commentary",
    "--kind", "user", "--kind", "agent", "--limit", "12",
  ]);
  const contextSearch = await parseWorkbenchAgentCliCommand([
    "thread", "context", "search", "--thread", "thread/1", "--query", "normal commentary",
    "--kind", "user", "--kind", "agent", "--limit", "12",
  ]);
  assert.equal(search.kind, "request");
  assert.equal(contextSearch.kind, "request");
  assert.deepEqual(contextSearch.request, search.request);
  assert.deepEqual(search.request, {
    body: { action: "search", kinds: ["user", "agent"], limit: 12, query: "normal commentary" },
    method: "POST",
    path: "/api/thread-context/thread%2F1",
    responseKind: "native",
  });

  const expand = await parseWorkbenchAgentCliCommand([
    "thread", "recall", "expand", "--thread", "thread/1", "--ref", "agent:item-2",
    "--before", "1", "--after", "3", "--max-chars", "18000",
  ]);
  assert.equal(expand.kind, "request");
  assert.deepEqual(expand.request.body, {
    action: "expand",
    after: 3,
    before: 1,
    maxChars: 18_000,
    ref: "agent:item-2",
  });

  const checkpoint = await parseWorkbenchAgentCliCommand([
    "checkpoint", "file-diff", "--thread", "thread-1", "--commit", "abc", "--file", "src/file.ts",
  ], { cwd: "C:/workspace" });
  assert.equal(checkpoint.kind, "request");
  assert.deepEqual(checkpoint.request.body, {
    action: "fileDiff",
    checkpointCommit: "abc",
    cwd: "C:/workspace",
    filePath: "src/file.ts",
    threadId: "thread-1",
  });
  assert.equal(checkpoint.request.responseKind, "native");

  const checkpointDiff = await parseWorkbenchAgentCliCommand([
    "checkpoint", "diff", "--thread", "thread-1", "--commit", "abc",
  ]);
  assert.equal(checkpointDiff.kind, "request");
  assert.equal(checkpointDiff.request.responseKind, "native");

  const checkpointRestore = await parseWorkbenchAgentCliCommand([
    "checkpoint", "restore", "--thread", "thread-1", "--commit", "abc", "--confirm",
  ]);
  assert.equal(checkpointRestore.kind, "request");
  assert.equal(checkpointRestore.request.responseKind, "checkpoint-restore");

  const browse = await parseWorkbenchAgentCliCommand([
    "browse", "run", "--thread", "thread-1", "--session", "research",
    "--command", "open http://localhost:3000 --headless",
    "--command", "snapshot --compact", "--var", "url=http://localhost:3000",
  ], { cwd: "C:/workspace" });
  assert.equal(browse.kind, "request");
  assert.deepEqual(browse.request.body, {
    cwd: "C:/workspace",
    script: "open http://localhost:3000 --headless\nsnapshot --compact",
    session: "research",
    threadId: "thread-1",
    vars: { url: "http://localhost:3000" },
  });
});

test("loads Collaboration content from files and rejects conflicting sources", async () => {
  const bodyPath = path.join(temporaryDirectoryPath, "body.md");
  await writeFile(bodyPath, "# Visible body\n", "utf8");
  const parsed = await parseWorkbenchAgentCliCommand([
    "collaboration", "posts", "create", "--parent", "post-1", "--body-file", bodyPath,
  ], { cwd: "C:/workspace" });
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request.body, {
    action: "create",
    body: "# Visible body\n",
    cwd: "C:/workspace",
    parentId: "post-1",
  });

  const conflicting = await parseWorkbenchAgentCliCommand([
    "collaboration", "posts", "create", "--parent", "post-1", "--body", "literal", "--body-file", bodyPath,
  ]);
  assert.equal(conflicting.kind, "error");
  assert.match(conflicting.error, /mutually exclusive/u);
});

test("rejects arbitrary request capabilities and unsafe restore", async () => {
  for (const args of [
    ["request", "--url", "http://localhost:3002/api/file"],
    ["checkpoint", "diff", "--thread", "thread-1", "--commit", "abc", "--project-id", "other"],
    ["checkpoint", "restore", "--thread", "thread-1", "--commit", "abc"],
    ["thread", "recall", "search", "--thread", "thread-1", "--query", "text", "--limit", "many"],
    ["thread", "recall", "expand", "--thread", "thread-1", "--ref", "agent:item", "--before", "-1"],
  ]) {
    const parsed = await parseWorkbenchAgentCliCommand(args);
    assert.equal(parsed.kind, "error");
  }
});

test("maps composable reload switches to one deduplicated fixed request", async () => {
  const parsed = await parseWorkbenchAgentCliCommand([
    "orchestrator", "reload", "--next-dev", "--codex-bridge", "--opencode-server", "--next-dev",
    "--orchestrator-logic", "--browse-controller", "--opencode-bridge",
  ]);
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request, {
    body: { scopes: ["orchestrator-logic", "browse-controller", "codex-bridge", "opencode-bridge", "opencode-server", "next-dev"] },
    method: "POST",
    path: "/api/orchestrator/reload",
    responseKind: "orchestrator-reload",
    waitForReload: true,
  });
  assert.equal((await parseWorkbenchAgentCliCommand(["orchestrator", "reload"])).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["orchestrator", "reload", "--unknown"])).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand([
    "browse", "run", "--thread", "thread-1", "--command", "doctor", "--stream-progress",
  ])).kind, "error");
});

test("runs the real CLI process and preserves the server response", async () => {
  const result = await execFileAsync(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", cliEntryPath,
    "thread", "recall", "search", "--thread", "real-process", "--query", "needle", "--kind", "agent",
  ], {
    cwd: temporaryDirectoryPath,
    env: { ...process.env, WORKBENCH_ORIGIN: origin },
  });
  assert.match(result.stdout, /"ok":true/u);
  assert.equal(result.stderr, "");
  assert.equal(requests.at(-1)?.url, "/api/thread-context/real-process");
  assert.deepEqual(JSON.parse(requests.at(-1)?.body ?? "{}"), {
    action: "search",
    kinds: ["agent"],
    query: "needle",
  });
});

test("generates executable POSIX and working Windows shims", async (context) => {
  const shimDirectoryPath = path.join(temporaryDirectoryPath, "shims");
  const env = { ...process.env };
  const installed = await new WorkbenchAgentCliEnvironment({
    cliEntryPath,
    origin,
    runtimeDirectoryPath: shimDirectoryPath,
  }).install(env);
  const posixContent = await readFile(installed.posixShimPath, "utf8");
  const powershellContent = await readFile(installed.powershellShimPath, "utf8");
  assert.match(posixContent, /^#!\/usr\/bin\/env sh/u);
  assert.match(powershellContent, /workbench-agent-cli-shim-v1/u);
  if (process.platform !== "win32") {
    assert.notEqual((await stat(installed.posixShimPath)).mode & 0o111, 0);
  }
  assert.equal(env.WORKBENCH_ORIGIN, origin);
  assert.equal(env.PATH?.split(path.delimiter)[0], shimDirectoryPath);

  if (process.platform !== "win32") {
    context.skip("Windows shim execution is only available on Windows.");
    return;
  }
  const multilineBody = "# Visible body\n\n- first | second";
  const multilinePrompt = "Inspect line one\nInspect line two";
  const multilineResult = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    [
      "$body = @'",
      multilineBody,
      "'@",
      "$prompt = @'",
      multilinePrompt,
      "'@",
      "wb collaboration posts create --parent post-multiline --body $body --prompt $prompt",
    ].join("\n"),
  ], {
    cwd: temporaryDirectoryPath,
    env: { ...env, Path: env.PATH },
  });
  assert.equal(multilineResult.stderr, "");
  const multilinePost = [...requests].reverse().find((request) => {
    if (request.url !== "/api/collaboration/posts" || request.method !== "POST") {
      return false;
    }
    return (JSON.parse(request.body) as { parentId?: string }).parentId === "post-multiline";
  });
  assert.deepEqual(JSON.parse(multilinePost?.body ?? "{}"), {
    action: "create",
    body: multilineBody,
    cwd: temporaryDirectoryPath,
    parentId: "post-multiline",
    prompt: multilinePrompt,
  });

  delete env.WORKBENCH_ORIGIN;
  reloadStatusReadCount = 0;
  const result = await execFileAsync(installed.windowsShimPath, [
    "orchestrator", "reload", "--codex-bridge", "--next-dev",
  ], {
    cwd: temporaryDirectoryPath,
    env,
    shell: true,
  });
  assert.equal(result.stdout, "Reload succeeded.\nApplied: codex-bridge\nQueued: next-dev\n");
  const reloadPost = [...requests].reverse().find((request) => request.url === "/api/orchestrator/reload" && request.method === "POST");
  assert.deepEqual(JSON.parse(reloadPost?.body ?? "{}"), { scopes: ["codex-bridge", "next-dev"] });
});

test("reports terminal reload failure and bounded timeout", async () => {
  const outputs = { stderr: "", stdout: "" };
  const io = {
    writeStderr: (value: string) => { outputs.stderr += value; },
    writeStdout: (value: string) => { outputs.stdout += value; },
  };
  let calls = 0;
  const failedCli = new WorkbenchAgentCli({
    env: { ...process.env, WORKBENCH_ORIGIN: origin },
    fetchRequest: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, state: calls === 1 ? "running" : "failed" }), { status: 200 });
    },
    io,
    reloadPollIntervalMs: 1,
    reloadTimeoutMs: 50,
  });
  assert.equal(await failedCli.run(["orchestrator", "reload", "--codex-bridge"]), 1);
  assert.equal(outputs.stderr, "Orchestrator reload failed.\n");

  outputs.stderr = "";
  const timeoutCli = new WorkbenchAgentCli({
    env: { ...process.env, WORKBENCH_ORIGIN: origin },
    fetchRequest: async () => new Response(JSON.stringify({ ok: true, state: "running" }), { status: 200 }),
    io,
    reloadPollIntervalMs: 1,
    reloadTimeoutMs: 3,
  });
  assert.equal(await timeoutCli.run(["orchestrator", "reload", "--next-dev"]), 1);
  assert.match(outputs.stderr, /did not settle/u);
});

test("fails before transport when the origin is missing or non-loopback", async () => {
  for (const unsafeOrigin of ["", "https://example.com", "http://example.com"]) {
    await assert.rejects(
      execFileAsync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", cliEntryPath, "thread", "context", "--thread", "unsafe"], {
        env: { ...process.env, WORKBENCH_ORIGIN: unsafeOrigin },
      }),
      (error: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.match(error.stderr ?? "", /WORKBENCH_ORIGIN/u);
        return true;
      },
    );
  }
});

test("adapts semantic text, useful JSON, native documents, and plain errors", () => {
  const request = (
    responseKind: WorkbenchAgentCliRequest["responseKind"],
    body: WorkbenchAgentCliRequest["body"] = {},
  ): WorkbenchAgentCliRequest => ({ body, method: "POST", path: "/fixed", responseKind });
  const adapt = (responseKind: WorkbenchAgentCliRequest["responseKind"], payload: object | string, body?: WorkbenchAgentCliRequest["body"], httpOk = true) => (
    adaptWorkbenchAgentCliResponse({
      httpOk,
      request: request(responseKind, body),
      text: typeof payload === "string" ? payload : JSON.stringify(payload),
    })
  );

  assert.deepEqual(adapt("thread-title", { title: "Clean output" }), {
    exitCode: 0,
    stderr: "",
    stdout: "Thread title set: Clean output\n",
  });
  assert.equal(adapt("checkpoint-create", { checkpointCommit: "abc" }, { action: "baseline" }).stdout, "Created checkpoint abc\n");
  assert.equal(adapt("checkpoint-create", { checkpointCommit: "def" }, { action: "diffCheckpoint" }).stdout, "Created diff checkpoint def\n");
  assert.equal(adapt("checkpoint-restore", { checkpointCommit: "abc" }).stdout, "Restored checkpoint abc\n");
  assert.equal(adapt("native", "## Context\n").stdout, "## Context\n");
  assert.equal(adapt("collaboration-memory-read", { memory: "remember this" }).stdout, "remember this");
  assert.equal(adapt("collaboration-memory-write", { message: "Collaboration memory replaced." }).stdout, "Collaboration memory replaced.\n");
  assert.equal(adapt("collaboration-post-mutation", { postId: "post-1" }, { action: "delete", postId: "post-1" }).stdout, "Deleted Collaboration post post-1\n");
  assert.equal(adapt("json", { sessions: [{ name: "research" }] }).stdout, '{\n  "sessions": [\n    {\n      "name": "research"\n    }\n  ]\n}\n');
  assert.deepEqual(adapt("native", { error: "Plain failure" }, {}, false), {
    exitCode: 1,
    stderr: "Plain failure\n",
    stdout: "",
  });
});

test("unwraps Browse output and honors Browse failure status inside HTTP success", () => {
  const browseRequest: WorkbenchAgentCliRequest = {
    body: { script: "doctor" },
    method: "POST",
    path: "/api/browse",
    responseKind: "browse-command",
  };
  assert.deepEqual(adaptWorkbenchAgentCliResponse({
    httpOk: true,
    request: browseRequest,
    text: JSON.stringify({ exitCode: 0, ok: true, stderr: "warning\n", stdout: "doctor result\n" }),
  }), {
    exitCode: 0,
    stderr: "warning\n",
    stdout: "doctor result\n",
  });
  assert.deepEqual(adaptWorkbenchAgentCliResponse({
    httpOk: true,
    request: browseRequest,
    text: JSON.stringify({ error: "Browse exploded", exitCode: 7, ok: false, stderr: "details", stdout: "" }),
  }), {
    exitCode: 7,
    stderr: "Browse exploded\ndetails\n",
    stdout: "",
  });
});
