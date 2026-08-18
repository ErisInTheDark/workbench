/*
 * Exports:
 * - No production exports; Node tests cover wb parsing, transport, and generated shims. Keywords: workbench, cli, test, shim, allowlist.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import WorkbenchAgentCommandController from "../../../orchestrator/WorkbenchAgentCommandController.ts";
import WorkbenchAgentCliEnvironment from "../../../orchestrator/WorkbenchAgentCliEnvironment.ts";
import {
  WORKBENCH_AGENT_CLI_HELP,
  parseWorkbenchAgentCliCommand,
  type WorkbenchAgentCliRequest,
} from "./workbench-agent-cli-commands.ts";
import { adaptWorkbenchAgentCliResponse } from "./workbench-agent-cli-responses.ts";

const execFileAsync = promisify(execFile);
const shellSourcePath = fileURLToPath(new URL("./workbench-agent-cli.sh", import.meta.url));
const requests: Array<{ body: string; method: string; url: string }> = [];
let agentCommandController: WorkbenchAgentCommandController;
let origin = "";
let server: http.Server;
let temporaryDirectoryPath = "";
let reloadStatusReadCount = 0;

before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === "/orchestrator/agent-command") {
      void agentCommandController.handleHttpRequest(request, response);
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ body, method: request.method ?? "", url: request.url ?? "" });
      if (request.url === "/orchestrator/reload") {
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
  agentCommandController = new WorkbenchAgentCommandController(origin, origin);
  temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), "workbench-agent-cli-test-"));
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(temporaryDirectoryPath, { recursive: true, force: true });
});

test("parses fixed thread, checkpoint, and Browse requests with cwd ownership", async () => {
  const title = await parseWorkbenchAgentCliCommand([
    "thread", "title", "--title", "A title",
  ], { callerThreadId: "thread/1", cwd: "C:/workspace" });
  assert.equal(title.kind, "request");
  assert.deepEqual(title.request, {
    body: { callerThreadId: "thread/1", cwd: "C:/workspace", title: "A title" },
    method: "POST",
    path: "/api/thread-title",
    responseKind: "thread-title",
  });

  const recall = await parseWorkbenchAgentCliCommand([
    "thread", "recall", "--thread", "thread/1", "--kind", "user-message", "--kind", "commentary", "--before", "user:item-1",
  ]);
  const context = await parseWorkbenchAgentCliCommand([
    "thread", "context", "--thread", "thread/1", "--kind", "user-message", "--kind", "commentary", "--before", "user:item-1",
  ]);
  assert.equal(recall.kind, "request");
  assert.equal(context.kind, "request");
  assert.deepEqual(context.request, recall.request);
  assert.equal(recall.request.path, "/api/thread-context/thread%2F1?before=user%3Aitem-1&kind=user-message&kind=commentary");

  const search = await parseWorkbenchAgentCliCommand([
    "thread", "recall", "search", "--thread", "thread/1", "--query", "normal commentary",
    "--kind", "user-message", "--kind", "commentary", "--limit", "12", "--before", "agent:item-9",
  ]);
  const contextSearch = await parseWorkbenchAgentCliCommand([
    "thread", "context", "search", "--thread", "thread/1", "--query", "normal commentary",
    "--kind", "user-message", "--kind", "commentary", "--limit", "12", "--before", "agent:item-9",
  ]);
  assert.equal(search.kind, "request");
  assert.equal(contextSearch.kind, "request");
  assert.deepEqual(contextSearch.request, search.request);
  assert.deepEqual(search.request, {
    body: { action: "search", before: "agent:item-9", kinds: ["user-message", "commentary"], limit: 12, query: "normal commentary" },
    method: "POST",
    path: "/api/thread-context/thread%2F1",
    responseKind: "native",
  });
  assert.equal((await parseWorkbenchAgentCliCommand([
    "thread", "recall", "search", "--thread", "thread/1", "--query", "needle", "--limit", "0",
  ])).kind, "error");

  const expand = await parseWorkbenchAgentCliCommand([
    "thread", "recall", "expand", "--thread", "thread/1", "--ref", "agent:item-2", "--cursor", "recall-v1:cursor",
  ]);
  assert.equal(expand.kind, "request");
  assert.deepEqual(expand.request.body, {
    action: "expand",
    cursor: "recall-v1:cursor",
    ref: "agent:item-2",
  });

  const gitOptions = { callerThreadId: "thread-1", cwd: "C:/workspace" };
  const gitAdd = await parseWorkbenchAgentCliCommand([
    "git", "add", "--", "src/file.ts", "src/nested",
  ], gitOptions);
  assert.equal(gitAdd.kind, "request");
  assert.deepEqual(gitAdd.request, {
    body: {
      action: "add",
      cwd: "C:/workspace",
      paths: ["src/file.ts", "src/nested"],
      threadId: "thread-1",
    },
    method: "POST",
    path: "/api/git",
    responseKind: "native",
  });
  const explicitWorktree = await parseWorkbenchAgentCliCommand([
    "git", "add", "--worktree", "C:/workspace/.worktrees/lab", "--", "src/file.ts",
  ], gitOptions);
  assert.equal(explicitWorktree.kind, "request");
  assert.deepEqual(explicitWorktree.request.body, {
    action: "add",
    cwd: "C:/workspace",
    paths: ["src/file.ts"],
    targetWorktree: "C:/workspace/.worktrees/lab",
    threadId: "thread-1",
  });
  const powerShellGitAdd = await parseWorkbenchAgentCliCommand([
    "git", "add", "src/file.ts", "src/nested",
  ], gitOptions);
  assert.equal(powerShellGitAdd.kind, "request");
  assert.deepEqual(powerShellGitAdd.request, gitAdd.request);
  const gitUnstage = await parseWorkbenchAgentCliCommand([
    "git", "unstage", "--", ".",
  ], gitOptions);
  assert.equal(gitUnstage.kind, "request");
  assert.deepEqual(gitUnstage.request.body, {
    action: "unstage",
    cwd: "C:/workspace",
    paths: ["."],
    threadId: "thread-1",
  });
  const gitCommit = await parseWorkbenchAgentCliCommand([
    "git", "commit", "--message", "A bounded commit",
  ], gitOptions);
  assert.equal(gitCommit.kind, "request");
  assert.deepEqual(gitCommit.request.body, {
    action: "commit",
    cwd: "C:/workspace",
    message: "A bounded commit",
    threadId: "thread-1",
  });
  const explicitWorktreeCommit = await parseWorkbenchAgentCliCommand([
    "git", "commit", "--worktree", "C:/workspace/.worktrees/lab", "--message", "A bounded commit",
  ], gitOptions);
  assert.equal(explicitWorktreeCommit.kind, "request");
  assert.equal(explicitWorktreeCommit.request.body?.targetWorktree, "C:/workspace/.worktrees/lab");
  assert.equal((await parseWorkbenchAgentCliCommand([
    "git", "commit", "--thread", "thread-1", "--message", "Nope",
  ], gitOptions)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["git", "add", "--", "src/file.ts"], { callerThreadId: null, cwd: "C:/workspace" })).kind, "error");

  const plan = await parseWorkbenchAgentCliCommand([
    "git", "arc", "plan", "-m", "Update files", "--", "src/file.ts",
  ], gitOptions);
  assert.equal(plan.kind, "request");
  assert.deepEqual(plan.request.body, {
    action: "plan",
    cwd: "C:/workspace",
    intentName: "Update files",
    paths: ["src/file.ts"],
    threadId: "thread-1",
  });

  const start = await parseWorkbenchAgentCliCommand([
    "git", "arc", "start", "--ref", "abc",
  ], gitOptions);
  assert.equal(start.kind, "request");
  assert.deepEqual(start.request.body, {
    action: "compare",
    checkpointCommit: "abc",
    cwd: "C:/workspace",
    threadId: "thread-1",
  });
  assert.equal(start.request.responseKind, "checkpoint-compare");

  const compare = await parseWorkbenchAgentCliCommand([
    "git", "arc", "compare", "--ref", "abc", "--", "src/file.ts",
  ], gitOptions);
  assert.equal(compare.kind, "request");
  assert.deepEqual(compare.request.body, {
    action: "compare",
    checkpointCommit: "abc",
    cwd: "C:/workspace",
    paths: ["src/file.ts"],
    threadId: "thread-1",
  });

  const checkpointDiff = await parseWorkbenchAgentCliCommand([
    "git", "arc", "diff", "--ref", "abc",
  ], gitOptions);
  assert.equal(checkpointDiff.kind, "request");
  assert.equal(checkpointDiff.request.responseKind, "native");

  const continuation = await parseWorkbenchAgentCliCommand([
    "git", "arc", "add", "--ref", "abc",
  ], gitOptions);
  assert.equal(continuation.kind, "request");
  assert.deepEqual(continuation.request.body, {
    action: "arcAdd",
    checkpointCommit: "abc",
    cwd: "C:/workspace",
    threadId: "thread-1",
  });

  const removal = await parseWorkbenchAgentCliCommand([
    "git", "arc", "remove", "--ref", "abc", "--", "src/file.ts",
  ], gitOptions);
  assert.equal(removal.kind, "request");
  assert.deepEqual(removal.request.body, {
    action: "arcRemove",
    checkpointCommit: "abc",
    cwd: "C:/workspace",
    paths: ["src/file.ts"],
    threadId: "thread-1",
  });

  const proposal = await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "--ref", "abc", "-m", "Title", "-m", "Description",
  ], gitOptions);
  assert.equal(proposal.kind, "request");
  assert.deepEqual(proposal.request.body, {
    action: "proposalCreate",
    checkpointCommit: "abc",
    cwd: "C:/workspace",
    description: "Description",
    threadId: "thread-1",
    title: "Title",
  });
  assert.equal(proposal.request.responseKind, "checkpoint-proposal");

  const checkpointRestore = await parseWorkbenchAgentCliCommand([
    "git", "arc", "restore", "--ref", "abc", "--confirm",
  ], gitOptions);
  assert.equal(checkpointRestore.kind, "request");
  assert.deepEqual(checkpointRestore.request.body, {
    action: "restore",
    checkpointCommit: "abc",
    confirmRestore: true,
    cwd: "C:/workspace",
    threadId: "thread-1",
  });
  assert.equal(checkpointRestore.request.responseKind, "checkpoint-restore");

  const checkpointPathRestore = await parseWorkbenchAgentCliCommand([
    "git", "arc", "restore", "--ref", "abc", "--", "src/one.ts", "src/two.ts",
  ], gitOptions);
  assert.equal(checkpointPathRestore.kind, "request");
  assert.deepEqual(checkpointPathRestore.request.body, {
    action: "restore",
    checkpointCommit: "abc",
    cwd: "C:/workspace",
    paths: ["src/one.ts", "src/two.ts"],
    threadId: "thread-1",
  });

  const powerShellCheckpointPathRestore = await parseWorkbenchAgentCliCommand([
    "git", "arc", "restore", "--ref", "abc", "src/one.ts", "src/two.ts",
  ], gitOptions);
  assert.equal(powerShellCheckpointPathRestore.kind, "request");
  assert.deepEqual(powerShellCheckpointPathRestore.request, checkpointPathRestore.request);

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

test("parses the cwd-owned subagent suite and requires managed thread identity", async () => {
  const options = {
    callerThreadId: "parent-thread",
    cwd: "C:/workspace",
    workbenchOrigin: "http://localhost:3000",
  };
  const list = await parseWorkbenchAgentCliCommand(["subagent", "list", "--settled", "--limit", "20", "--cursor", "next-page"], options);
  assert.equal(list.kind, "request");
  assert.deepEqual(list.request, {
    body: {
      action: "list",
      callerThreadId: "parent-thread",
      cursor: "next-page",
      cwd: "C:/workspace",
      limit: 20,
      settled: true,
    },
      method: "POST",
      path: "/api/subagents",
      responseKind: "subagent-list",
    });
  const profiles = await parseWorkbenchAgentCliCommand(["subagent", "profiles"], options);
  assert.equal(profiles.kind, "request");
  assert.deepEqual(profiles.request, {
    body: {
      action: "profiles",
      callerThreadId: "parent-thread",
      cwd: "C:/workspace",
      workbenchOrigin: "http://localhost:3000",
    },
    method: "POST",
    path: "/api/subagents",
    responseKind: "json",
  });

  const create = await parseWorkbenchAgentCliCommand([
    "subagent", "create", "--profile", "profile-1", "--name", "sparkle-scout",
    "--title", "Inspect code", "--message", "Find the bug.",
  ], options);
  assert.equal(create.kind, "request");
  assert.deepEqual(create.request.body, {
    action: "create",
    callerThreadId: "parent-thread",
    cwd: "C:/workspace",
    message: "Find the bug.",
    name: "sparkle-scout",
    profileId: "profile-1",
    title: "Inspect code",
    workbenchOrigin: "http://localhost:3000",
  });
  assert.equal(create.request.responseKind, "subagent-create");

  const message = await parseWorkbenchAgentCliCommand([
    "subagent", "message", "--id", "child-thread", "--message", "Continue safely.",
  ], options);
  assert.equal(message.kind, "request");
  assert.deepEqual(message.request.body, {
    action: "message",
    callerThreadId: "parent-thread",
    cwd: "C:/workspace",
    message: "Continue safely.",
    threadId: "child-thread",
    workbenchOrigin: "http://localhost:3000",
  });

  const parentMessage = await parseWorkbenchAgentCliCommand([
    "subagent", "message", "--parent", "--message", "Parent-facing progress.",
  ], options);
  assert.equal(parentMessage.kind, "request");
  assert.deepEqual(parentMessage.request.body, {
    action: "message",
    callerThreadId: "parent-thread",
    cwd: "C:/workspace",
    message: "Parent-facing progress.",
    parent: true,
    workbenchOrigin: "http://localhost:3000",
  });
  assert.equal((await parseWorkbenchAgentCliCommand([
    "subagent", "message", "--parent", "--id", "child-thread", "--message", "Ambiguous.",
  ], options)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand([
    "subagent", "message", "--message", "Missing target.",
  ], options)).kind, "error");

  const wait = await parseWorkbenchAgentCliCommand([
    "subagent", "wait", "--id", "child-thread", "--id", "other-child",
  ], options);
  assert.equal(wait.kind, "request");
  if (wait.kind === "request") {
    assert.deepEqual(wait.request.body, {
      action: "wait",
      callerThreadId: "parent-thread",
      cwd: "C:/workspace",
      threadIds: ["child-thread", "other-child"],
      workbenchOrigin: "http://localhost:3000",
    });
  }
  assert.equal((await parseWorkbenchAgentCliCommand([
    "subagent", "wait", "--id", "child-thread", "--id", "child-thread",
  ], options)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["subagent", "stop", "--id", "child-thread"], options)).kind, "request");
  assert.equal((await parseWorkbenchAgentCliCommand(["subagent", "profiles"], { ...options, callerThreadId: null })).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["subagent", "list"], { ...options, callerThreadId: null })).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["subagent", "list", "--limit", "21"], options)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand([
    "subagent", "create", "--profile", "profile-1", "--name", "missing-fields",
  ], options)).kind, "error");
});

test("rejects removed Collaboration commands", async () => {
  const parsed = await parseWorkbenchAgentCliCommand(["collaboration", "posts", "read"]);
  assert.equal(parsed.kind, "error");
  if (parsed.kind === "error") {
    assert.match(parsed.error, /Unsupported wb command/u);
  }
});

test("rejects arbitrary request capabilities and unsafe restore", async () => {
  for (const args of [
    ["request", "--url", "http://localhost:3002/api/file"],
    ["git", "arc", "diff", "--thread", "thread-1", "--ref", "abc", "--", "src/file.ts"],
    ["git", "arc", "restore", "--thread", "thread-1", "--ref", "abc"],
    ["git", "arc", "restore", "--ref", "abc"],
    ["thread", "recall", "search", "--thread", "thread-1", "--query", "text", "--limit", "many"],
    ["thread", "recall", "expand", "--thread", "thread-1", "--ref", "agent:item", "--before", "-1"],
  ]) {
    const parsed = await parseWorkbenchAgentCliCommand(args);
    assert.equal(parsed.kind, "error");
  }
});

test("renders complete root help and exact focused Git and orchestrator help", async () => {
  const root = await parseWorkbenchAgentCliCommand(["--help"]);
  assert.deepEqual(root, { help: WORKBENCH_AGENT_CLI_HELP, kind: "help" });
  assert.match(WORKBENCH_AGENT_CLI_HELP, /^Usage:\n/u);
  assert.match(WORKBENCH_AGENT_CLI_HELP, /wb git arc plan -m <short-intent>/u);
  assert.match(WORKBENCH_AGENT_CLI_HELP, /wb git arc add --ref <ref>/u);
  assert.match(WORKBENCH_AGENT_CLI_HELP, /wb git arc remove --ref <ref>/u);
  assert.match(WORKBENCH_AGENT_CLI_HELP, /wb git arc propose --ref <ref> -m <title>/u);
  assert.doesNotMatch(WORKBENCH_AGENT_CLI_HELP, /git checkpoint/u);
  assert.match(WORKBENCH_AGENT_CLI_HELP, /--confirm \| -- <path> \[<path>\.\.\.\]/u);
  assert.doesNotMatch(WORKBENCH_AGENT_CLI_HELP, /wb collaboration/u);
  assert.match(WORKBENCH_AGENT_CLI_HELP, /Help commands:\n  wb subagent --help/u);
  assert.match(WORKBENCH_AGENT_CLI_HELP, /  wb thread recall --help/u);
  assert.match(WORKBENCH_AGENT_CLI_HELP, /  wb git arc --help/u);
  assert.doesNotMatch(WORKBENCH_AGENT_CLI_HELP, /Workbench agent CLI|Compatibility alias|--hard|--orchestrator-server|--help \[--thread/u);

  const git = await parseWorkbenchAgentCliCommand(["git", "--help"]);
  assert.deepEqual(git, {
    help: `Usage:
  wb git <command> [options]

Commands:
  wb git add [--worktree <absolute-path>] -- <path> [<path>...]
    Add currently changed files beneath the paths to this thread's commit selection.

  wb git unstage [--worktree <absolute-path>] -- <path> [<path>...]
    Remove exact files or descendants from this thread's commit selection.

  wb git commit [--worktree <absolute-path>] --message <message>
    Commit only this thread's selected files, then clear the selection on success.

Run from the repository root and use . with add to select all changed files.
Run from the repository root and use . with unstage to clear the thread selection.
Use --worktree with an absolute registered worktree path while keeping the command cwd as the control-plane project.
Git commands derive the current managed thread ID from Workbench caller context.
Unrelated files in the ordinary Git index remain outside the thread-owned commit.
`,
    kind: "help",
  });
  assert.doesNotMatch(git.kind === "help" ? git.help : "", /checkpoint/u);

  const orchestrator = await parseWorkbenchAgentCliCommand(["orchestrator", "--help"]);
  assert.deepEqual(orchestrator, {
    help: `Usage:
  wb orchestrator reload [--all] [--orchestrator-logic] [--browse-controller] [--codex-bridge] [--opencode-bridge] [--opencode-server] [--next-dev]

Options:
  --all                 Reload all non-destructive orchestrator scopes: orchestrator-logic, browse-controller, codex-bridge, opencode-bridge, next-dev.
  --orchestrator-logic  Reload declared orchestrator modules.
  --browse-controller   Drain and replace Browse controller code without restarting browser sessions.
  --codex-bridge        Reload Codex bridge code without restarting the stable Codex app-server.
  --opencode-bridge     Reload OpenCode bridge code.
  --opencode-server     Restart the managed OpenCode server.
  --next-dev            Restart the Next.js development server.

At least one option is required.
Use the narrowest applicable scope.
`,
    kind: "help",
  });
});

test("every deprecated checkpoint command returns the current plan and arc migration guide", async () => {
  for (const command of ["baseline", "plan", "implement", "compare", "diff", "commit", "restore"]) {
    const canonical = await parseWorkbenchAgentCliCommand(["git", "checkpoint", command]);
    const alias = await parseWorkbenchAgentCliCommand(["checkpoint", command]);
    assert.deepEqual(alias, canonical);
    assert.equal(canonical.kind, "help");
    assert.match(canonical.help, /wb git arc plan -m/u);
    assert.match(canonical.help, /wb git arc start --ref/u);
    assert.match(canonical.help, /wb git arc add --ref <current-ref>/u);
    assert.match(canonical.help, /wb git arc remove --ref <current-ref>/u);
    assert.match(canonical.help, /even when no new paths are supplied/u);
    assert.match(canonical.help, /wb git arc propose --ref/u);
  }
  const oldPlan = await parseWorkbenchAgentCliCommand(["git", "plan", "-m", "Old", "--", "src/a.ts"]);
  assert.equal(oldPlan.kind, "help");
  assert.match(oldPlan.help, /wb git arc plan -m/u);
});

test("routes canonical, compatibility, and leaf help to the nearest owning group", async () => {
  const canonicalRecall = await parseWorkbenchAgentCliCommand(["thread", "recall", "--help"]);
  const contextRecall = await parseWorkbenchAgentCliCommand(["thread", "context", "search", "--help"]);
  assert.deepEqual(contextRecall, canonicalRecall);

  const canonicalArc = await parseWorkbenchAgentCliCommand(["git", "arc", "--help"]);
  const arcLeaf = await parseWorkbenchAgentCliCommand(["git", "arc", "plan", "--help"]);
  assert.deepEqual(arcLeaf, canonicalArc);
  assert.match(canonicalArc.kind === "help" ? canonicalArc.help : "", /wb git arc remove --ref <ref>/u);

  const browse = await parseWorkbenchAgentCliCommand(["browse", "--help"]);
  const browseLeaf = await parseWorkbenchAgentCliCommand(["browse", "run", "--help"]);
  assert.deepEqual(browseLeaf, browse);
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

test("expands safe reload all without server replacement and keeps hard restart hidden", async () => {
  const parsed = await parseWorkbenchAgentCliCommand(["orchestrator", "reload", "--all"]);
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request.body, {
    scopes: ["orchestrator-logic", "browse-controller", "codex-bridge", "opencode-bridge", "next-dev"],
  });
  const explicitServer = await parseWorkbenchAgentCliCommand(["orchestrator", "reload", "--all", "--opencode-server"]);
  assert.equal(explicitServer.kind, "request");
  if (explicitServer.kind === "request") {
    assert.deepEqual(explicitServer.request.body, {
      scopes: ["orchestrator-logic", "browse-controller", "codex-bridge", "opencode-bridge", "next-dev", "opencode-server"],
    });
  }
  const hard = await parseWorkbenchAgentCliCommand(["orchestrator", "reload", "--hard"]);
  assert.equal(hard.kind, "request");
  if (hard.kind === "request") assert.deepEqual(hard.request.body, { scopes: ["orchestrator-server"] });
  assert.equal((await parseWorkbenchAgentCliCommand(["orchestrator", "reload", "--hard", "--all"])).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["orchestrator", "reload", "--hard", "--codex-bridge"])).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["orchestrator", "reload", "--orchestrator-server"])).kind, "error");
  const help = await parseWorkbenchAgentCliCommand(["--help"]);
  assert.equal(help.kind, "help");
  if (help.kind === "help") {
    assert.match(help.help, /--all/u);
    assert.doesNotMatch(help.help, /--hard|--orchestrator-server/u);
  }
});

test("runs the native shell transport and preserves the server response", async () => {
  const result = await execFileAsync("bash", [
    shellSourcePath,
    "thread", "recall", "search", "--thread", "real-process", "--query", "needle", "--kind", "commentary",
  ], {
    cwd: temporaryDirectoryPath,
    env: { ...process.env, WORKBENCH_ORIGIN: origin },
  });
  assert.match(result.stdout, /"ok":true/u);
  assert.equal(result.stderr, "");
  assert.equal(requests.at(-1)?.url, "/api/thread-context/real-process");
  assert.deepEqual(JSON.parse(requests.at(-1)?.body ?? "{}"), {
    action: "search",
    kinds: ["commentary"],
    query: "needle",
  });
});

test("generates executable POSIX and working Windows shims", async (context) => {
  const shimDirectoryPath = path.join(temporaryDirectoryPath, "shims");
  const env = { ...process.env };
  const installed = await new WorkbenchAgentCliEnvironment({
    origin,
    runtimeDirectoryPath: shimDirectoryPath,
    shellSourcePath,
  }).install(env);
  const posixContent = await readFile(installed.posixShimPath, "utf8");
  const powershellContent = await readFile(installed.powershellShimPath, "utf8");
  assert.match(posixContent, /^#!\/usr\/bin\/env bash/u);
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
  const reloadPost = [...requests].reverse().find((request) => request.url === "/orchestrator/reload" && request.method === "POST");
  assert.deepEqual(JSON.parse(reloadPost?.body ?? "{}"), { scopes: ["codex-bridge", "next-dev"] });
});

test("redirects a PATH-resolved wb command to the Workbench install in cwd", async () => {
  const cwdRequests: string[] = [];
  const cwdServer = http.createServer((request, response) => {
    let requestBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { requestBody += chunk; });
    request.on("end", () => {
      cwdRequests.push(requestBody);
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("cwd-local\n");
    });
  });
  await new Promise<void>((resolve) => cwdServer.listen(0, "127.0.0.1", resolve));
  try {
    const cwdAddress = cwdServer.address();
    assert(cwdAddress && typeof cwdAddress === "object");
    const workbenchRoot = path.join(temporaryDirectoryPath, "cwd-workbench");
    const cwdRuntimePath = path.join(workbenchRoot, "webapp", "node_modules", ".bin");
    const pathRuntimePath = path.join(temporaryDirectoryPath, "path-workbench-bin");
    const cwdEnv = { ...process.env };
    await new WorkbenchAgentCliEnvironment({
      origin: `http://127.0.0.1:${cwdAddress.port}`,
      runtimeDirectoryPath: cwdRuntimePath,
      shellSourcePath,
    }).install(cwdEnv);
    await new WorkbenchAgentCliEnvironment({
      origin: `http://127.0.0.1:${cwdAddress.port}`,
      runtimeDirectoryPath: path.join(workbenchRoot, "node_modules", ".bin"),
      shellSourcePath,
    }).install({ ...process.env });
    const pathEnv = { ...process.env };
    const pathInstall = await new WorkbenchAgentCliEnvironment({
      origin,
      runtimeDirectoryPath: pathRuntimePath,
      shellSourcePath,
    }).install(pathEnv);

    const result = await execFileAsync("bash", [pathInstall.posixShimPath, "subagent", "list"], {
      cwd: workbenchRoot,
      env: { ...process.env, WORKBENCH_ORIGIN: origin },
      timeout: 2_000,
    });

    assert.equal(result.stdout, "cwd-local\n");
    assert.equal(cwdRequests.length, 1);
    assert.match(cwdRequests[0], /(?:^|&)cwd=.*cwd-workbench(?:&|$)/u);
  } finally {
    await new Promise<void>((resolve, reject) => cwdServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("fails before transport when the origin is missing or non-loopback", async () => {
  for (const unsafeOrigin of ["", "https://example.com", "http://example.com"]) {
    await assert.rejects(
      execFileAsync("bash", [shellSourcePath, "thread", "context", "--thread", "unsafe"], {
        cwd: temporaryDirectoryPath,
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
  assert.equal(adapt("checkpoint-create", { checkpointCommit: "abc" }, { action: "plan" }).stdout, "Created Git plan abc\n");
  assert.equal(adapt("checkpoint-create", { checkpointCommit: "def" }, { action: "arcAdd" }).stdout, "Created successor arc ref def\n");
  assert.equal(adapt("checkpoint-proposal", { proposalId: "proposal-one" }).stdout, "Workbench arc proposal: proposal-one\n");
  assert.equal(adapt("checkpoint-restore", { checkpointCommit: "abc" }).stdout, "Restored arc abc\n");
  assert.equal(adapt("checkpoint-restore", {
    checkpointCommit: "abc",
    restoredPaths: ["src/one.ts", "src/two.ts"],
  }, { paths: ["src/one.ts", "src/two.ts"] }).stdout, "Restored 2 paths from arc abc:\nsrc/one.ts\nsrc/two.ts\n");
  assert.equal(adapt("checkpoint-restore", {
    checkpointCommit: "abc",
    restoredPaths: [],
  }, { paths: ["src/one.ts"] }).stdout, "Selected paths already matched arc abc\n");
  assert.deepEqual(adapt("subagent-create", { threadId: "child-thread" }), {
    exitCode: 0,
    stderr: "",
    stdout: "child-thread\n",
  });
  assert.equal(adapt("native", "## Context\n").stdout, "## Context\n");
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
