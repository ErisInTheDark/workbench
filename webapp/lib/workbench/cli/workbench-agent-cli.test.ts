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
  listWorkbenchAgentCliCommandDescriptors,
  parseWorkbenchAgentCliCommand,
  type WorkbenchAgentCliRequest,
} from "./workbench-agent-cli-commands.ts";
import { adaptWorkbenchAgentCliResponse } from "./workbench-agent-cli-responses.ts";
import { parseGitArcFailureReceipt } from "../git/git-arc-failures.ts";
import { parseGitArcReceipt } from "../git/git-arc-receipts.ts";
import { listWorkbenchAgentCommands } from "../commands/workbench-agent-command-registry.ts";

const execFileAsync = promisify(execFile);
const gitArcOptions = { callerThreadId: "thread-1", cwd: "C:/workspace" };
const shellSourcePath = fileURLToPath(new URL("./workbench-agent-cli.sh", import.meta.url));
const requests: Array<{ body: string; method: string; url: string }> = [];
let agentCommandController: WorkbenchAgentCommandController;
let origin = "";
let server: http.Server;
let temporaryDirectoryPath = "";
let reloadStatusReadCount = 0;

test("canonical command descriptors are immutable and unique", () => {
  const descriptors = listWorkbenchAgentCliCommandDescriptors();
  const definitions = listWorkbenchAgentCommands();
  assert.ok(descriptors.length > 0);
  assert.equal(descriptors.length, definitions.length);
  assert.equal(new Set(descriptors.map(({ words }) => words.join(" "))).size, descriptors.length);
  assert.ok(descriptors.every(({ description, usage, words }) => description && usage.startsWith("wb ") && words.length > 0));
  assert.equal(Object.isFrozen(descriptors), true);
  assert.equal(Object.isFrozen(descriptors[0]), true);
  assert.equal(Object.isFrozen(descriptors[0]?.words), true);
  assert.equal(definitions.find(({ words }) => words.join(" ") === "browse raw")?.hideFromMcp, true);
});

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
    body: { action: "set", callerThreadId: "thread/1", cwd: "C:/workspace", title: "A title" },
    method: "POST",
    path: "/api/thread-title",
    responseKind: "thread-title",
  });

  const titleGet = await parseWorkbenchAgentCliCommand([
    "thread", "title", "get",
  ], { callerThreadId: "thread/1", cwd: "C:/workspace" });
  assert.equal(titleGet.kind, "request");
  assert.deepEqual(titleGet.request, {
    body: { action: "get", callerThreadId: "thread/1", cwd: "C:/workspace" },
    method: "POST",
    path: "/api/thread-title",
    responseKind: "thread-title-get",
  });

  const resume = await parseWorkbenchAgentCliCommand(["thread", "resume"], { callerThreadId: "thread/1", cwd: "C:/workspace" });
  assert.equal(resume.kind, "request");
  assert.deepEqual(resume.request, {
    body: { callerThreadId: "thread/1", cwd: "C:/workspace" },
    method: "POST",
    path: "/api/thread-resume",
    responseKind: "thread-resume",
  });

  const recall = await parseWorkbenchAgentCliCommand([
    "thread", "recall", "--thread", "thread/1", "--kind", "user-message", "--kind", "commentary", "--before", "user:item-1",
  ], { callerThreadId: "ambient/thread" });
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
  ], { callerThreadId: "ambient/thread" });
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
  ], { callerThreadId: "ambient/thread" });
  assert.equal(expand.kind, "request");
  assert.deepEqual(expand.request.body, {
    action: "expand",
    cursor: "recall-v1:cursor",
    ref: "agent:item-2",
  });

  const currentThreadOptions = { callerThreadId: "current/thread", cwd: "C:/workspace" };
  const currentRecall = await parseWorkbenchAgentCliCommand(["thread", "recall", "--kind", "user-message"], currentThreadOptions);
  const currentSearch = await parseWorkbenchAgentCliCommand(["thread", "recall", "search", "--query", "needle"], currentThreadOptions);
  const currentExpand = await parseWorkbenchAgentCliCommand(["thread", "recall", "expand", "--ref", "agent:item-2"], currentThreadOptions);
  assert.equal(currentRecall.kind, "request");
  assert.equal(currentSearch.kind, "request");
  assert.equal(currentExpand.kind, "request");
  assert.equal(currentRecall.request.path, "/api/thread-context/current%2Fthread?kind=user-message");
  assert.equal(currentSearch.request.path, "/api/thread-context/current%2Fthread");
  assert.equal(currentExpand.request.path, "/api/thread-context/current%2Fthread");
  for (const command of [
    ["thread", "recall"],
    ["thread", "recall", "search", "--query", "needle"],
    ["thread", "recall", "expand", "--ref", "agent:item-2"],
  ]) {
    assert.equal((await parseWorkbenchAgentCliCommand(command, { callerThreadId: null })).kind, "error");
  }

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
    "git", "arc", "plan", "-m", "Update files", "-m", "Coordinate the shared boundary.", "--", "src/file.ts",
  ], gitOptions);
  assert.equal(plan.kind, "request");
  assert.deepEqual(plan.request.body, {
    action: "plan",
    cwd: "C:/workspace",
    harness: "codex",
    intentDescription: "Coordinate the shared boundary.",
    intentName: "Update files",
    paths: ["src/file.ts"],
    threadId: "thread-1",
  });
  const amendCommit = await parseWorkbenchAgentCliCommand([
    "git", "commit", "--amend", "a".repeat(40), "--message", "Rewrite history",
  ], gitOptions);
  assert.equal(amendCommit.kind, "request");
  assert.deepEqual(amendCommit.request.body, {
    action: "commit",
    amendTarget: "a".repeat(40),
    cwd: "C:/workspace",
    message: "Rewrite history",
    threadId: "thread-1",
  });

  const start = await parseWorkbenchAgentCliCommand([
    "git", "arc", "start", "--ref", "abc",
  ], gitOptions);
  assert.equal(start.kind, "request");
  assert.deepEqual(start.request.body, {
    action: "arcStart",
    checkpointCommit: "abc",
    cwd: "C:/workspace",
    harness: "codex",
    threadId: "thread-1",
  });
  assert.equal(start.request.responseKind, "git-arc-start");

  const continuedArc = await parseWorkbenchAgentCliCommand([
    "git", "arc", "continue", "--ref", "abc",
  ], gitOptions);
  assert.equal(continuedArc.kind, "request");
  assert.deepEqual(continuedArc.request.body, {
    action: "arcContinue",
    checkpointCommit: "abc",
    cwd: "C:/workspace",
    harness: "codex",
    threadId: "thread-1",
  });
  assert.equal(continuedArc.request.responseKind, "git-arc-continue");

  const compare = await parseWorkbenchAgentCliCommand([
    "git", "arc", "compare", "--", "src/file.ts",
  ], gitOptions);
  assert.equal(compare.kind, "request");
  assert.deepEqual(compare.request.body, {
    action: "compare",
    cwd: "C:/workspace",
    harness: "codex",
    paths: ["src/file.ts"],
    threadId: "thread-1",
  });
  assert.equal(compare.request.responseKind, "git-arc-compare");

  const checkpointDiff = await parseWorkbenchAgentCliCommand([
    "git", "arc", "diff",
  ], gitOptions);
  assert.equal(checkpointDiff.kind, "request");
  assert.equal(checkpointDiff.request.responseKind, "git-arc-diff");

  const emptyAddition = await parseWorkbenchAgentCliCommand([
    "git", "arc", "add",
  ], gitOptions);
  assert.equal(emptyAddition.kind, "error");

  const addition = await parseWorkbenchAgentCliCommand([
    "git", "arc", "add", "--", "src/new.ts",
  ], gitOptions);
  assert.equal(addition.kind, "request");
  assert.deepEqual(addition.request.body, {
    action: "arcAdd",
    cwd: "C:/workspace",
    harness: "codex",
    paths: ["src/new.ts"],
    threadId: "thread-1",
  });

  const adoption = await parseWorkbenchAgentCliCommand([
    "git", "arc", "adopt", "--", "src/dirty.ts",
  ], gitOptions);
  assert.equal(adoption.kind, "request");
  assert.deepEqual(adoption.request.body, {
    action: "arcAdopt",
    cwd: "C:/workspace",
    harness: "codex",
    paths: ["src/dirty.ts"],
    threadId: "thread-1",
  });

  const move = await parseWorkbenchAgentCliCommand([
    "git", "arc", "mv", "src/old.ts", "src/new.ts",
  ], gitOptions);
  assert.equal(move.kind, "request");
  assert.equal(move.request.responseKind, "git-arc-mv");
  assert.deepEqual(move.request.body, {
    action: "arcMove",
    cwd: "C:/workspace",
    harness: "codex",
    move: { kind: "operands", operands: ["src/old.ts", "src/new.ts"] },
    threadId: "thread-1",
  });

  const regexMove = await parseWorkbenchAgentCliCommand([
    "git", "arc", "mv", "--regex", "^src/(.+)$", "--replace", "tests/$1", "--", "src",
  ], gitOptions);
  assert.equal(regexMove.kind, "request");
  assert.deepEqual(regexMove.request.body, {
    action: "arcMove",
    cwd: "C:/workspace",
    harness: "codex",
    move: { confirm: false, kind: "regex", pattern: "^src/(.+)$", replacement: "tests/$1", roots: ["src"] },
    threadId: "thread-1",
  });
  const launcherNormalizedRegexMove = await parseWorkbenchAgentCliCommand([
    "git", "arc", "mv", "--confirm", "--regex", "^src/(.+)$", "--replace", "tests/$1", "src",
  ], gitOptions);
  assert.equal(launcherNormalizedRegexMove.kind, "request");
  assert.deepEqual(launcherNormalizedRegexMove.request.body, {
    action: "arcMove",
    cwd: "C:/workspace",
    harness: "codex",
    move: { confirm: true, kind: "regex", pattern: "^src/(.+)$", replacement: "tests/$1", roots: ["src"] },
    threadId: "thread-1",
  });

  const removal = await parseWorkbenchAgentCliCommand([
    "git", "arc", "remove", "--", "src/file.ts",
  ], gitOptions);
  assert.equal(removal.kind, "request");
  assert.deepEqual(removal.request.body, {
    action: "arcRemove",
    cwd: "C:/workspace",
    harness: "codex",
    paths: ["src/file.ts"],
    threadId: "thread-1",
  });

  const proposal = await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "-m", "Title", "-m", "Description",
  ], gitOptions);
  assert.equal(proposal.kind, "request");
  assert.deepEqual(proposal.request.body, {
    action: "proposalCreate",
    amend: false,
    cwd: "C:/workspace",
    description: "Description",
    harness: "codex",
    threadId: "thread-1",
    title: "Title",
  });
  assert.equal(proposal.request.responseKind, "git-arc-propose");

  const bulletDescription = "- move thread Git out of Next\n- keep claims until index normalization succeeds\n- prevent optional explorer index writes";
  const bulletProposal = await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "-m", "Two-state Git acceptance", "-m", bulletDescription,
  ], gitOptions);
  assert.equal(bulletProposal.kind, "request");
  assert.equal(bulletProposal.request.body?.description, bulletDescription);

  const missingProposalTitle = await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "-m", "-m", "Description",
  ], gitOptions);
  assert.equal(missingProposalTitle.kind, "error");
  assert.match(missingProposalTitle.error, /-m requires a value/u);

  const replacementProposal = await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "--replace", "proposal-one", "-m", "Replacement",
  ], gitOptions);
  assert.equal(replacementProposal.kind, "request");
  assert.deepEqual(replacementProposal.request.body, {
    action: "proposalCreate",
    amend: false,
    cwd: "C:/workspace",
    description: "",
    harness: "codex",
    replaceProposalId: "proposal-one",
    threadId: "thread-1",
    title: "Replacement",
  });

  const rescindProposal = await parseWorkbenchAgentCliCommand([
    "git", "arc", "rescind", "--proposal", "proposal-one",
  ], gitOptions);
  assert.equal(rescindProposal.kind, "request");
  assert.deepEqual(rescindProposal.request.body, {
    action: "proposalRescind",
    cwd: "C:/workspace",
    harness: "codex",
    proposalId: "proposal-one",
    threadId: "thread-1",
  });

  const checkpointRestore = await parseWorkbenchAgentCliCommand([
    "git", "arc", "restore", "--ref", "abc", "--confirm",
  ], gitOptions);
  assert.equal(checkpointRestore.kind, "request");
  assert.deepEqual(checkpointRestore.request.body, {
    action: "restore",
    checkpointCommit: "abc",
    confirmRestore: true,
    cwd: "C:/workspace",
    harness: "codex",
    threadId: "thread-1",
  });
  assert.equal(checkpointRestore.request.responseKind, "git-arc-restore");

  const checkpointPathRestore = await parseWorkbenchAgentCliCommand([
    "git", "arc", "restore", "--ref", "abc", "--", "src/one.ts", "src/two.ts",
  ], gitOptions);
  assert.equal(checkpointPathRestore.kind, "request");
  assert.deepEqual(checkpointPathRestore.request.body, {
    action: "restore",
    checkpointCommit: "abc",
    cwd: "C:/workspace",
    harness: "codex",
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

test("every deprecated checkpoint command returns the current plan and arc migration guide", async () => {
  let guide: string | null = null;
  for (const command of ["baseline", "plan", "implement", "compare", "diff", "commit", "restore"]) {
    const canonical = await parseWorkbenchAgentCliCommand(["git", "checkpoint", command]);
    const alias = await parseWorkbenchAgentCliCommand(["checkpoint", command]);
    assert.deepEqual(alias, canonical);
    assert.equal(canonical.kind, "help");
    guide ??= canonical.help;
    assert.equal(canonical.help, guide);
  }
  const oldPlan = await parseWorkbenchAgentCliCommand(["git", "plan", "-m", "Old", "--", "src/a.ts"]);
  assert.equal(oldPlan.kind, "help");
  assert.equal(oldPlan.help, guide);
});

test("routes canonical, compatibility, and leaf help to the nearest owning group", async () => {
  const canonicalRecall = await parseWorkbenchAgentCliCommand(["thread", "recall", "--help"]);
  const contextRecall = await parseWorkbenchAgentCliCommand(["thread", "context", "search", "--help"]);
  assert.deepEqual(contextRecall, canonicalRecall);

  const canonicalArc = await parseWorkbenchAgentCliCommand(["git", "arc", "--help"]);
  const arcLeaf = await parseWorkbenchAgentCliCommand(["git", "arc", "plan", "--help"]);
  assert.deepEqual(arcLeaf, canonicalArc);
  assert.match(canonicalArc.kind === "help" ? canonicalArc.help : "", /wb git arc remove -- <claimed-path>/u);

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
    scopes: ["orchestrator-logic", "browse-controller", "codex-bridge", "mcp", "opencode-bridge", "next-dev"],
  });
  const explicitServer = await parseWorkbenchAgentCliCommand(["orchestrator", "reload", "--all", "--opencode-server"]);
  assert.equal(explicitServer.kind, "request");
  if (explicitServer.kind === "request") {
    assert.deepEqual(explicitServer.request.body, {
      scopes: ["orchestrator-logic", "browse-controller", "codex-bridge", "mcp", "opencode-bridge", "next-dev", "opencode-server"],
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
  assert.deepEqual(adapt("thread-title-get", { title: "Current task" }), {
    exitCode: 0,
    stderr: "",
    stdout: "Thread title: Current task\n",
  });
  assert.equal(adapt("thread-resume", { accepted: true }).stdout, "Thread resume scheduled.\n");
  const planRef = "a".repeat(40);
  const successorRef = "b".repeat(40);
  const planResponse = adapt("git-arc-plan", {
    checkpointCommit: planRef,
    intentName: "Polish arc UI",
    scopePaths: ["src/one.ts"],
  }, { action: "plan", paths: ["src/one.ts"] });
  assert.match(planResponse.stdout, new RegExp(`^Created Git plan ${planRef}\\n`, "u"));
  assert.deepEqual(parseGitArcReceipt(planResponse.stdout), {
    action: "plan",
    claimedPaths: ["src/one.ts"],
    intentName: "Polish arc UI",
    ref: planRef,
    selectedPaths: ["src/one.ts"],
    version: 1,
  });
  const driftResponse = adapt("git-arc-plan", {
    checkpointCommit: successorRef,
    intentName: "Polish arc UI",
    preservedDriftPathCount: 2,
    preservedDriftPaths: ["src/one.ts", "src/two.ts"],
    scopePaths: ["src/one.ts", "src/two.ts"],
  }, { action: "planAdd", paths: ["src/three.ts"] });
  assert.match(driftResponse.stdout, /WARNING: These paths still use older plan baselines:[\s\S]*src\/one\.ts[\s\S]*src\/two\.ts/u);
  assert.match(driftResponse.stdout, /mcp__wb__git_arc_diff/u);
  assert.match(driftResponse.stdout, new RegExp(successorRef, "u"));
  assert.match(driftResponse.stdout, /src\/one\.ts.*src\/two\.ts/u);
  assert.match(driftResponse.stdout, /mcp__wb__git_arc_plan_add.*src\/one\.ts.*src\/two\.ts/u);
  assert.ok(driftResponse.stdout.indexOf("mcp__wb__git_arc_diff") < driftResponse.stdout.indexOf("mcp__wb__git_arc_plan_add"));
  assert.match(driftResponse.stdout, /arc start will reject preserved drift/u);
  assert.deepEqual(parseGitArcReceipt(driftResponse.stdout), {
    action: "plan",
    claimedPaths: ["src/one.ts", "src/two.ts"],
    intentName: "Polish arc UI",
    ref: successorRef,
    selectedPaths: ["src/three.ts"],
    version: 1,
  });
  assert.match(adapt("git-arc-add", { checkpointCommit: successorRef }, { action: "arcAdd" }).stdout, /^Created successor arc ref/u);
  const movePreview = adapt("git-arc-mv", {
    additionalClaims: ["src/old.ts", "tests/old.ts"],
    checkpointCommit: planRef,
    intentName: "Move tests",
    mappings: [{ destination: "tests/old.ts", source: "src/old.ts" }],
    matchedPathCount: 3,
    mode: "preview",
    remainingMatchCount: 2,
    scopePaths: ["src/existing.ts"],
  }, { action: "arcMove" });
  assert.match(movePreview.stdout, /^This command will rename the following files:/u);
  assert.match(movePreview.stdout, /1 of 3 matching paths.*2 matching paths remain/u);
  assert.match(movePreview.stdout, /Use the command again with --confirm/u);
  assert.deepEqual(parseGitArcReceipt(movePreview.stdout), {
    action: "mv",
    additionalClaims: ["src/old.ts", "tests/old.ts"],
    claimedPaths: ["src/existing.ts"],
    intentName: "Move tests",
    mappings: [{ destination: "tests/old.ts", source: "src/old.ts" }],
    matchedPathCount: 3,
    mode: "preview",
    ref: planRef,
    remainingMatchCount: 2,
    version: 1,
  });
  assert.match(adapt("git-arc-mv", {
    additionalClaims: ["tests/old.ts"], checkpointCommit: successorRef,
    mappings: [{ destination: "tests/old.ts", source: "src/old.ts" }],
    matchedPathCount: 1, mode: "applied", remainingMatchCount: 0, scopePaths: ["src/old.ts", "tests/old.ts"],
  }, { action: "arcMove" }).stdout, /^Moved 1 path\./u);
  assert.match(adapt("git-arc-propose", {
    proposalId: "proposal-one",
    sourceCheckpoint: successorRef,
  }).stdout, /^Workbench arc proposal: proposal-one/u);
  assert.match(adapt("git-arc-restore", { checkpointCommit: successorRef }).stdout, /^Restored arc/u);
  assert.match(adapt("git-arc-restore", {
    checkpointCommit: successorRef,
    restoredPaths: ["src/one.ts", "src/two.ts"],
  }, { paths: ["src/one.ts", "src/two.ts"] }).stdout, /^Restored 2 paths from arc/u);
  assert.match(adapt("git-arc-restore", {
    checkpointCommit: successorRef,
    restoredPaths: [],
  }, { paths: ["src/one.ts"] }).stdout, /^Selected paths already matched arc/u);
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
  const structuredFailure = adapt("git-arc-plan", {
    error: "Adoption overlaps ordinary plan scope.",
    gitArcFailure: {
      action: "plan",
      code: "adoptedPathOverlap",
      overlaps: [{ adoptedPath: "src/dirty.ts", ordinaryPath: "src/dirty.ts" }],
      version: 1,
    },
  }, { action: "plan", adoptPaths: ["src/dirty.ts"], paths: ["src/dirty.ts"] }, false);
  assert.match(structuredFailure.stderr, /^Adoption overlaps ordinary plan scope\./u);
  assert.deepEqual(parseGitArcFailureReceipt(structuredFailure.stderr), {
    action: "plan",
    code: "adoptedPathOverlap",
    overlaps: [{ adoptedPath: "src/dirty.ts", ordinaryPath: "src/dirty.ts" }],
    version: 1,
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

test("parses current-plan creation and revision commands", async () => {
  const empty = await parseWorkbenchAgentCliCommand(["git", "arc", "plan", "-m", "Draft"], gitArcOptions);
  assert.equal(empty.kind, "request");
  const adopted = await parseWorkbenchAgentCliCommand([
    "git", "arc", "plan", "-m", "Adopt dirt", "--adopt", "src/dirty-a.ts", "--adopt", "src/dirty-b.ts", "--", "src/clean.ts",
  ], gitArcOptions);
  assert.equal(adopted.kind, "request");
  assert.deepEqual(adopted.request.body, {
    action: "plan",
    adoptPaths: ["src/dirty-a.ts", "src/dirty-b.ts"],
    cwd: "C:/workspace",
    harness: "codex",
    intentDescription: "",
    intentName: "Adopt dirt",
    paths: ["src/clean.ts"],
    threadId: "thread-1",
  });
  const add = await parseWorkbenchAgentCliCommand(["git", "arc", "plan", "add", "--", "src/a.ts"], gitArcOptions);
  assert.equal(add.kind, "request");
  assert.equal(add.request.body?.action, "planAdd");
  const remove = await parseWorkbenchAgentCliCommand(["git", "arc", "plan", "remove", "--", "src/a.ts"], gitArcOptions);
  assert.equal(remove.kind, "request");
  assert.equal(remove.request.body?.action, "planRemove");
  const adopt = await parseWorkbenchAgentCliCommand(["git", "arc", "plan", "adopt", "--", "src/a.ts"], gitArcOptions);
  assert.equal(adopt.kind, "request");
  assert.equal(adopt.request.body?.action, "planAdopt");
});

test("parses combined plan start and ref-free start", async () => {
  const combined = await parseWorkbenchAgentCliCommand([
    "git", "arc", "plan", "start", "-m", "Continue", "--adopt", "src/dirty.ts", "--", "src/a.ts",
  ], gitArcOptions);
  assert.equal(combined.kind, "request");
  assert.equal(combined.request.body?.action, "planStart");
  assert.deepEqual(combined.request.body?.adoptPaths, ["src/dirty.ts"]);
  const start = await parseWorkbenchAgentCliCommand(["git", "arc", "start"], gitArcOptions);
  assert.equal(start.kind, "request");
  assert.equal(start.request.body?.action, "arcStart");
});

test("parses explicit plan-ref diff and targeted amend", async () => {
  const diff = await parseWorkbenchAgentCliCommand(["git", "arc", "diff", "--ref", "abcdef1", "--", "src/a.ts"], gitArcOptions);
  assert.equal(diff.kind, "request");
  assert.equal(diff.request.body?.checkpointCommit, "abcdef1");
  const amend = await parseWorkbenchAgentCliCommand(["git", "arc", "propose", "--amend", "proposal-one"], gitArcOptions);
  assert.equal(amend.kind, "request");
  assert.equal(amend.request.body?.amendProposalId, "proposal-one");
});
