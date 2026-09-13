/*
 * Exports:
 * - No production exports; Node tests cover wb parsing, questionnaire JSON, paged arc output, transport, response text, and generated shims.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import WorkbenchAgentCommandLogger from "../../../orchestrator/WorkbenchAgentCommandLogger";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import WorkbenchAgentCommandController from "../../../orchestrator/WorkbenchAgentCommandController.ts";
import { NativeThreadIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchAgentCliEnvironment from "../../../orchestrator/WorkbenchAgentCliEnvironment.ts";
import {
  listWorkbenchAgentCliCommandDescriptors,
  parseWorkbenchAgentCliCommand,
  type WorkbenchAgentCliRequest,
} from "./workbench-agent-cli-commands.ts";
import { adaptWorkbenchAgentCliResponse } from "./workbench-agent-cli-responses.ts";
import { parseGitArcFailureReceipt } from "workbench-shared/workbench/git/git-arc-failures";
import { parseGitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import { parseGitArcStatus } from "workbench-shared/workbench/git/git-arc-status";
import { listWorkbenchAgentCommands } from "../commands/workbench-agent-command-registry.ts";

const execFileAsync = promisify(execFile);

function execFileWithInput(command: string, args: string[], input: string, options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<{ exitCode: number; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, stderr, stdout }));
    child.stdin.end(input);
  });
}
const gitArcOptions = { callerThreadId: "thread-1", cwd: "C:/workspace" };

test("status selectors preserve equivalent CLI and MCP inputs", async () => {
  const definition = listWorkbenchAgentCommands().find(({ words }) => words.join(" ") === "git arc status");
  assert.ok(definition, "status must be registered for CLI and MCP");
  const mcp = await definition.buildRequestFromJson({ full: ["dirty", "unclaimed-dirt"] }, {
    ...gitArcOptions, callerHarness: "codex", workbenchOrigin: null,
  });
  for (const flags of [["--full=dirty,unclaimed-dirt"], ["--full", "dirty,unclaimed-dirt"]]) {
    const parsed = await parseWorkbenchAgentCliCommand(["git", "arc", "status", ...flags], gitArcOptions);
    assert.equal(parsed.kind, "request");
    if (parsed.kind !== "request") assert.fail("Expected status request.");
    assert.deepEqual(parsed.request.body?.full, ["dirty", "unclaimed-dirt"]);
    assert.deepEqual(parsed.request.body, mcp.body);
    const status = { pending: [], accepted: [], dirtyClaims: ["a", "b", "c", "d", "e", "f"], cleanClaims: [], unclaimedDirt: [], recovery: [], unavailableRecovery: [] };
    const output = adaptWorkbenchAgentCliResponse({ httpOk: true, request: parsed.request, text: JSON.stringify(status) });
    assert.deepEqual(parseGitArcStatus(output.stdout).data, status);
    const empty = adaptWorkbenchAgentCliResponse({ httpOk: true, request: parsed.request, text: JSON.stringify({ ...status, dirtyClaims: [] }) });
    assert.equal(empty.stdout, "");
  }
  const invalid = await parseWorkbenchAgentCliCommand(["git", "arc", "status", "--full=everything"], gitArcOptions);
  assert.equal(invalid.kind, "error");
});

test("claim updates return only net changes while retaining counts and recovery facts", async () => {
  for (const kind of ["plan", "arc"]) {
    for (const changed of [false, true]) {
      const parsed = await parseWorkbenchAgentCliCommand(["git", kind, "claims", "--inherit"], gitArcOptions);
      assert.equal(parsed.kind, "request");
      const acceptedProposals = [{ proposalId: "accepted", commitSha: "b".repeat(40) }];
      const planningDrift = { previousRef: "c".repeat(40), paths: ["drift.ts"] };
      const output = adaptWorkbenchAgentCliResponse({
        httpOk: true, request: parsed.request,
        text: JSON.stringify({
          checkpointCommit: "a".repeat(40), phase: kind === "plan" ? "plan" : "active",
          scopePaths: ["unchanged.ts", "new.ts"], claimedPaths: ["unchanged.ts"],
          plannedPaths: ["unchanged.ts", "new.ts"], adoptedPaths: ["unchanged.ts"],
          addedClaims: changed ? ["new.ts"] : [], removedClaims: changed ? ["old.ts"] : [],
          acceptedProposals, planningDrift, unchanged: !changed,
        }),
      });
      const receipt = parseGitArcReceipt(output.stdout);
      assert.ok(receipt);
      assert.equal(receipt.fullScope, false);
      assert.equal(receipt.claimedPathCount, kind === "plan" ? 1 : 2);
      assert.equal(receipt.plannedPathCount, kind === "plan" ? 2 : undefined);
      assert.equal(receipt.adoptedPathCount, 1);
      assert.deepEqual(receipt.additionalClaims ?? [], changed ? ["new.ts"] : []);
      assert.deepEqual(receipt.removedClaims ?? [], changed ? ["old.ts"] : []);
      assert.deepEqual(receipt.acceptedProposals, acceptedProposals);
      assert.deepEqual(receipt.planningDrift, [planningDrift]);
      assert.doesNotMatch(output.stdout, /unchanged\.ts/u);
    }
  }
});

test("Git argument refusals retain semantic facts before a request exists", async () => {
  for (const [args, reason] of [
    [["git", "plan", "claims"], "missingPlanName"],
    [["git", "arc", "unrecognised"], "unsupportedCommand"],
    [["git", "arc", "claims"], "inheritanceRequired"],
    [["git", "arc", "propose", "--amend", "--replace", "proposal-one"], "conflictingProposalTargets"],
  ] as const) {
    const result = await parseWorkbenchAgentCliCommand([...args], gitArcOptions);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") assert.fail("Expected argument refusal.");
    const failure = parseGitArcFailureReceipt(result.error);
    assert.ok(failure && "rejection" in failure);
    assert.deepEqual(failure.rejection, { reason });
  }
});

test("start receipts describe net scope changes rather than reacquired claims", async () => {
  const parsed = await parseWorkbenchAgentCliCommand(["git", "arc", "start"], gitArcOptions);
  assert.equal(parsed.kind, "request");
  const output = adaptWorkbenchAgentCliResponse({
    httpOk: true, request: parsed.request,
    text: JSON.stringify({
      checkpointCommit: "a".repeat(40), scopePaths: ["kept.ts", "new.ts"],
      acquiredClaims: ["kept.ts", "new.ts"], releasedClaims: ["kept.ts", "old.ts"],
      addedClaims: [], removedClaims: [],
    }),
  });
  const receipt = parseGitArcReceipt(output.stdout);
  assert.deepEqual(receipt?.additionalClaims, ["new.ts"]);
  assert.deepEqual(receipt?.removedClaims, ["old.ts"]);
  assert.equal(receipt?.claimedPathCount, 2);
});

test("scope output preserves proposal recovery across workspace members", async () => {
  const parsed = await parseWorkbenchAgentCliCommand(["git", "arc", "scope"], gitArcOptions);
  assert.equal(parsed.kind, "request");
  const proposals = [{ proposalId: "pending-id", status: "proposed" }, { proposalId: "accepted-id", status: "committed" }];
  const output = adaptWorkbenchAgentCliResponse({
    httpOk: true, request: parsed.request,
    text: JSON.stringify({
      checkpointCommit: "a".repeat(40), phase: "active", claimedPaths: [],
      members: proposals.map((proposal, index) => ({
        rootId: `root-${index}`, checkpointCommit: "a".repeat(40), proposals: [proposal],
      })),
    }),
  });
  assert.deepEqual(parseGitArcReceipt(output.stdout)?.proposals, proposals);
});

test("scope output preserves planned and live inventory without duplicated transport JSON", async () => {
  const parsed = await parseWorkbenchAgentCliCommand(["git", "arc", "scope"], gitArcOptions);
  assert.equal(parsed.kind, "request");
  const output = adaptWorkbenchAgentCliResponse({
    httpOk: true, request: parsed.request,
    text: JSON.stringify({ checkpointCommit: "a".repeat(40), intentName: "revise", phase: "plan", plannedPaths: ["new.ts"], claimedPaths: ["old.ts"], adoptedPaths: [] }),
  });
  const receipt = parseGitArcReceipt(output.stdout);
  assert.deepEqual(receipt?.plannedPaths, ["new.ts"]);
  assert.deepEqual(receipt?.claimedPaths, ["old.ts"]);
  assert.equal(receipt?.phase, "plan");
});

test("combined claim CLI preserves addition, removal and adoption as separate arrays", async () => {
  const parsed = await parseWorkbenchAgentCliCommand([
    "git", "arc", "claims", "--inherit", "--", "new.ts", "-old.ts", "*dirty.ts", "./-literal.ts",
  ], gitArcOptions);
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request.body?.addPaths, ["new.ts", "./-literal.ts"]);
  assert.deepEqual(parsed.request.body?.removePaths, ["old.ts"]);
  assert.deepEqual(parsed.request.body?.adoptPaths, ["dirty.ts"]);
  assert.equal(parsed.request.body?.inherit, true);
  const missing = await parseWorkbenchAgentCliCommand(["git", "arc", "claims", "--", "new.ts"], gitArcOptions);
  assert.equal(missing.kind, "error");
});

test("plan claim revisions recover removal-only operands when PowerShell consumes the separator", async () => {
  const parsed = await parseWorkbenchAgentCliCommand(["git", "plan", "claims", "--inherit", "-old.ts"], gitArcOptions);
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request.body?.removePaths, ["old.ts"]);
});

test("proposal targeting keeps legacy content amendments and message-only rewords distinct", async () => {
  const propose = listWorkbenchAgentCommands().find(({ words }) => words.join("_") === "git_arc_propose")!;
  const context = { cwd: "C:/workspace", callerThreadId: "thread-1", callerHarness: "codex" as const, workbenchOrigin: null };
  const content = await propose.buildRequestFromJson({
    amendProposalId: "accepted-id", paths: ["one.ts"], freshTitle: "new commit",
  }, context);
  assert.equal(content.body?.amend, true);
  assert.equal(content.body?.amendProposalId, "accepted-id");
  assert.equal(content.body?.title, "");
  await assert.rejects(propose.buildRequestFromJson({
    amendProposalId: "accepted-id", replace: "pending-id", title: "conflicting target",
  }, context));
  const reword = await parseWorkbenchAgentCliCommand(["git", "arc", "reword", "--proposal", "accepted-id", "--title", "message only"], gitArcOptions);
  assert.equal(reword.kind, "request");
  assert.equal(reword.request.body?.amend, false);
  assert.equal(reword.request.body?.paths, undefined);
});
const reloadCatalog = [
  { access: "agent" as const, description: "Core", safeAll: true, scope: "server:core" },
  { access: "agent" as const, description: "Browse", safeAll: true, scope: "server:browse" },
  { access: "agent" as const, description: "Codex bridge", safeAll: true, scope: "server:codex" },
  { access: "agent" as const, description: "Commands", safeAll: true, scope: "server:commands" },
  { access: "agent" as const, description: "MCP", safeAll: true, scope: "server:mcp" },
  { access: "agent" as const, description: "OpenCode bridge", safeAll: true, scope: "server:opencode" },
  { access: "agent" as const, description: "Topology", safeAll: false, scope: "server:topology" },
  { access: "cli" as const, description: "Codex app-server", safeAll: false, scope: "harness:codex" },
  { access: "cli" as const, description: "OpenCode app-server", safeAll: false, scope: "harness:opencode" },
  { access: "operator" as const, description: "Process", safeAll: false, scope: "server:process" },
];
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
  assert.equal(descriptors.length, definitions.filter(({ hideFromRootHelp }) => !hideFromRootHelp).length);
  assert.equal(new Set(descriptors.map(({ words }) => words.join(" "))).size, descriptors.length);
  assert.ok(descriptors.every(({ description, usage, words }) => description && usage.startsWith("wb ") && words.length > 0));
  assert.equal(Object.isFrozen(descriptors), true);
  assert.equal(Object.isFrozen(descriptors[0]), true);
  assert.equal(Object.isFrozen(descriptors[0]?.words), true);
  assert.equal(definitions.find(({ words }) => words.join(" ") === "browse raw")?.hideFromMcp, true);
});

test("token commands restrict managed threads without restricting direct users", async () => {
  const userOutside = { callerThreadId: null, cwd: "C:/other", projectRoot: "C:/workbench" };
  const threadOutside = { callerThreadId: "thread", cwd: "C:/other", projectRoot: "C:/workbench" };
  const threadInside = { callerThreadId: "thread", cwd: "C:/workbench", projectRoot: "C:/workbench" };
  assert.deepEqual(await parseWorkbenchAgentCliCommand(["tokens", "--model", "gpt-5-test", "--", "exact  text"], userOutside), {
    kind: "request",
    request: {
      body: { cwd: "C:/other", kind: "text", model: "gpt-5-test", text: "exact  text" },
      method: "POST",
      path: "/internal/tokens",
      responseKind: "native",
    },
  });
  assert.deepEqual(await parseWorkbenchAgentCliCommand(["tokens", "instructions"], userOutside), {
    kind: "request",
    request: {
      body: { callerThreadId: null, cwd: "C:/other", kind: "instructions", model: "gpt-5.6" },
      method: "POST",
      path: "/internal/tokens",
      responseKind: "native",
    },
  });
  assert.deepEqual(await parseWorkbenchAgentCliCommand(["tokens", "project"], threadOutside), {
    kind: "request",
    request: {
      body: { cwd: "C:/other", kind: "projectInstructions", model: "gpt-5.6" },
      method: "POST",
      path: "/internal/tokens",
      responseKind: "native",
    },
  });
  assert.deepEqual(await parseWorkbenchAgentCliCommand(["tokens", "project", "--model", "gpt-5-test"], userOutside), {
    kind: "request",
    request: {
      body: { cwd: "C:/other", kind: "projectInstructions", model: "gpt-5-test" },
      method: "POST",
      path: "/internal/tokens",
      responseKind: "native",
    },
  });
  assert.equal((await parseWorkbenchAgentCliCommand(["tokens", "instructions"], threadOutside)).kind, "error");
  assert.deepEqual(await parseWorkbenchAgentCliCommand(["tokens", "instructions"], threadInside), {
    kind: "request",
    request: {
      body: { callerThreadId: "thread", cwd: "C:/workbench", kind: "instructions", model: "gpt-5.6" },
      method: "POST",
      path: "/internal/tokens",
      responseKind: "native",
    },
  });
  const userHelp = await parseWorkbenchAgentCliCommand(["--help"], userOutside);
  const outsideThreadHelp = await parseWorkbenchAgentCliCommand(["--help"], threadOutside);
  const insideThreadHelp = await parseWorkbenchAgentCliCommand(["--help"], threadInside);
  assert.equal(userHelp.kind, "help");
  assert.equal(outsideThreadHelp.kind, "help");
  assert.equal(insideThreadHelp.kind, "help");
  assert.match(userHelp.help, /wb tokens instructions/u);
  assert.match(userHelp.help, /wb tokens project/u);
  assert.doesNotMatch(outsideThreadHelp.help, /wb tokens instructions/u);
  assert.match(outsideThreadHelp.help, /wb tokens project/u);
  assert.match(insideThreadHelp.help, /wb tokens instructions/u);
  assert.match(insideThreadHelp.help, /wb tokens project/u);
});

test("transcript CLI accepts Workbench ids directly and restricts managed callers", async () => {
  const context = { cwd: "C:/workbench", projectRoot: "C:/workbench", callerThreadId: "caller" };
  const parsed = await parseWorkbenchAgentCliCommand([
    "transcript", "search", "--thread", "wb-thread", "--query", "100%_literal", "--json",
  ], context);
  assert.equal(parsed.kind, "request");
  if (parsed.kind !== "request") return;
  assert.deepEqual(parsed.request.body?.threads, ["wb-thread"]);
  assert.deepEqual(parsed.request.body?.queries, ["100%_literal"]);
  assert.equal((await parseWorkbenchAgentCliCommand(["transcript", "read", "--thread", "wb-thread"], context)).kind, "request");
  assert.equal((await parseWorkbenchAgentCliCommand(["transcript", "read"], context)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["transcript", "search", "--query", "x"], { ...context, cwd: "C:/elsewhere" })).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["transcript", "projects"], { ...context, cwd: "C:/elsewhere", callerThreadId: null })).kind, "request");
});

test("parses Markdown toc requests and exposes focused help", async () => {
  const parsed = await parseWorkbenchAgentCliCommand(["toc", "AGENTS.md"], { cwd: "C:/workspace" });
  assert.deepEqual(parsed, {
    kind: "request",
    request: {
      body: { cwd: "C:/workspace", file: "AGENTS.md" },
      method: "POST",
      path: "/api/toc",
      responseKind: "native",
    },
  });
  assert.equal((await parseWorkbenchAgentCliCommand(["toc", "notes.txt"], { cwd: "C:/workspace" })).kind, "error");

  const rootHelp = await parseWorkbenchAgentCliCommand(["--help"]);
  const tocHelp = await parseWorkbenchAgentCliCommand(["toc", "--help"]);
  assert.equal(rootHelp.kind, "help");
  assert.equal(tocHelp.kind, "help");
  assert.match(rootHelp.help, /wb toc <file>/u);
  assert.match(tocHelp.help, /wb toc <file>/u);
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
          response.end(JSON.stringify({ appliedScopes: ["server:codex"], completedAt: Date.now(), error: null, ok: true, queuedScopes: [], requestedScopes: ["server:codex"], startedAt: 1, state: "succeeded" }));
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
  agentCommandController = new WorkbenchAgentCommandController(origin, {
    resolveCaller: async (threadId, _cwd, harness) => ({
      threadId: WorkbenchThreadIdSchema.parse(threadId === "hook-thread" ? "wb:hook-thread" : threadId),
      nativeThreadId: NativeThreadIdSchema.parse(threadId === "hook-thread" ? threadId : `native:${threadId}`),
      harness: WorkbenchHarnessSchema.parse(harness),
    }),
    checkApplyPatchClaims: async ({ paths }) => {
      if (paths.some((filePath) => filePath.endsWith("unavailable.ts"))) throw new Error("claim registry unavailable");
      const uncoveredPaths = paths.filter((filePath) => filePath.endsWith("unclaimed.ts"));
      return { allowed: uncoveredPaths.length === 0, uncoveredPaths };
    },
    executeBrowseRequest: async () => { throw new Error("unexpected direct Browse dispatch"); },
    executeSessionRequest: async () => { throw new Error("unexpected direct Browse session dispatch"); },
    executeThreadRecallRequest: async (request) => {
      const body = JSON.stringify(request.body ?? {});
      requests.push({ body, method: request.method, url: request.path });
      return Response.json({ method: request.method, ok: true, url: request.path });
    },
    getReloadScopeCatalog: () => reloadCatalog,
  }, undefined, undefined, new WorkbenchAgentCommandLogger({ writeLine: () => {} }));
  temporaryDirectoryPath = await mkdtemp(path.join(os.tmpdir(), "workbench-agent-cli-test-"));
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(temporaryDirectoryPath, { recursive: true, force: true });
});

test("questionnaire CLI accepts descriptive headers without a fixed character cap", async () => {
  const question = {
    header: "implementation approval",
    id: "approval",
    options: [],
    question: "Should the approved implementation proceed?",
  };
  const accepted = await parseWorkbenchAgentCliCommand([
    "request", "user", "input", "--questions-json", JSON.stringify([question]),
  ], { callerThreadId: "thread/1", cwd: "C:/workspace" });
  assert.equal(accepted.kind, "request");
  assert.deepEqual(accepted.request.body?.questions, [question]);
});

test("questionnaire CLI reports field validation separately from malformed JSON", async () => {
  const parse = (source: string) => parseWorkbenchAgentCliCommand([
    "request", "user", "input", "--questions-json", source,
  ], { callerThreadId: "thread/1", cwd: "C:/workspace" });
  const emptyHeader = await parse(JSON.stringify([{
    header: " ",
    id: "approval",
    options: [],
    question: "Should the approved implementation proceed?",
  }]));
  assert.equal(emptyHeader.kind, "error");
  assert.match(emptyHeader.error, /header/u);
  assert.doesNotMatch(emptyHeader.error, /requires --questions-json to contain/u);

  const malformed = await parse("[");
  assert.equal(malformed.kind, "error");
  assert.match(malformed.error, /JSON/u);
});

test("claim analysis parses as a read-only cli command without MCP exposure", async () => {
  const result = await parseWorkbenchAgentCliCommand([
    "stats", "claims", "--file", "workbench:src/view.ts", "--range", "90d", "--page", "2",
  ], { cwd: "C:/workspace", callerThreadId: "thread/1" });
  assert.equal(result.kind, "request");
  assert.deepEqual(result.request.body, {
    cwd: "C:/workspace", file: "workbench:src/view.ts", range: "90d", page: 2,
  });
  const command = listWorkbenchAgentCommands().find(({ words }) => words.join(" ") === "stats claims");
  assert.equal(command?.hideFromMcp, true);
  assert.equal(command?.effects.readOnly, true);
});

test("parses fixed thread, checkpoint, and Browse requests with cwd ownership", async () => {
  const questions = [{
    header: "details",
    id: "details",
    options: [],
    question: "What should change?",
  }];
  const questionnaire = await parseWorkbenchAgentCliCommand([
    "request", "user", "input", "--questions-json", JSON.stringify(questions),
  ], { callerThreadId: "thread/1", cwd: "C:/workspace" });
  assert.equal(questionnaire.kind, "request");
  const questionnaireRequestKey = questionnaire.request.body?.requestKey;
  assert.match(String(questionnaireRequestKey), /^workbench-mcp:/u);
  assert.deepEqual(questionnaire.request, {
    body: {
      callerThreadId: "thread/1",
      cwd: "C:/workspace",
      questions,
      requestKey: questionnaireRequestKey,
    },
    method: "POST",
    path: "/api/request-user-input",
    responseKind: "json",
  });
  assert.equal((await parseWorkbenchAgentCliCommand([
    "request", "user", "input", "--questions-json", JSON.stringify([...questions, ...questions, ...questions, ...questions]),
  ], { callerThreadId: "thread/1", cwd: "C:/workspace" })).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand([
    "request", "user", "input", "--questions-json", JSON.stringify([{ ...questions[0], options: [
      { description: "", label: "one" },
      { description: "", label: "two" },
      { description: "", label: "three" },
      { description: "", label: "four" },
    ] }]),
  ], { callerThreadId: "thread/1", cwd: "C:/workspace" })).kind, "error");

  const title = await parseWorkbenchAgentCliCommand([
    "task", "set", "--title", "A title", "--current-title", "Current title",
  ], { callerThreadId: "thread/1", cwd: "C:/workspace" });
  assert.equal(title.kind, "request");
  assert.deepEqual(title.request, {
    body: { action: "set", callerThreadId: "thread/1", currentTitle: "Current title", cwd: "C:/workspace", title: "A title" },
    method: "POST",
    path: "/api/thread-title",
    responseKind: "thread-title",
  });

  const titleGet = await parseWorkbenchAgentCliCommand([
    "task", "get",
  ], { callerThreadId: "thread/1", cwd: "C:/workspace" });
  assert.equal(titleGet.kind, "request");
  assert.deepEqual(titleGet.request, {
    body: { action: "get", callerThreadId: "thread/1", cwd: "C:/workspace" },
    method: "POST",
    path: "/api/thread-title",
    responseKind: "thread-title-get",
  });

  for (const status of ["completed", "blocked"] as const) {
    const taskStatus = await parseWorkbenchAgentCliCommand(["task", status], {
      callerThreadId: "thread/1",
      cwd: "C:/workspace",
    });
    assert.equal(taskStatus.kind, "request");
    assert.deepEqual(taskStatus.request, {
      body: { callerThreadId: "thread/1", cwd: "C:/workspace", status },
      method: "POST",
      path: "/api/thread-status",
      responseKind: "thread-status",
    });
  }

  const refresh = await parseWorkbenchAgentCliCommand(["thread", "refresh"], { callerThreadId: "thread/1", cwd: "C:/workspace" });
  assert.equal(refresh.kind, "request");
  assert.deepEqual(refresh.request, {
    body: { callerThreadId: "thread/1", cwd: "C:/workspace" },
    method: "POST",
    path: "/api/thread-resume",
    responseKind: "thread-refresh",
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
    "git", "commit", "--title", "A bounded commit", "--description", "Explain the bounded work.",
  ], gitOptions);
  assert.equal(gitCommit.kind, "request");
  assert.deepEqual(gitCommit.request.body, {
    action: "commit",
    cwd: "C:/workspace",
    message: "A bounded commit\n\nExplain the bounded work.",
    threadId: "thread-1",
  });
  const explicitWorktreeCommit = await parseWorkbenchAgentCliCommand([
    "git", "commit", "--worktree", "C:/workspace/.worktrees/lab", "--title", "A bounded commit",
  ], gitOptions);
  assert.equal(explicitWorktreeCommit.kind, "request");
  assert.equal(explicitWorktreeCommit.request.body?.targetWorktree, "C:/workspace/.worktrees/lab");
  assert.equal((await parseWorkbenchAgentCliCommand([
    "git", "commit", "--thread", "thread-1", "--title", "Nope",
  ], gitOptions)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand([
    "git", "commit", "--message", "Legacy flag",
  ], gitOptions)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["git", "add", "--", "src/file.ts"], { callerThreadId: null, cwd: "C:/workspace" })).kind, "error");

  const plan = await parseWorkbenchAgentCliCommand([
    "git", "plan", "claims", "-m", "Update files", "-m", "Coordinate the shared boundary.", "--", "src/file.ts",
  ], gitOptions);
  assert.equal(plan.kind, "request");
  assert.deepEqual(plan.request.body, {
    action: "planClaims",
    inherit: false,
    start: false,
    roots: [],
    removePaths: [],
    adoptPaths: [],
    cwd: "C:/workspace",
    harness: "codex",
    intentDescription: "Coordinate the shared boundary.",
    intentName: "Update files",
    addPaths: ["src/file.ts"],
    threadId: "thread-1",
  });
  const amendCommit = await parseWorkbenchAgentCliCommand([
    "git", "commit", "--amend", "a".repeat(40), "--title", "Rewrite history",
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

  const wait = await parseWorkbenchAgentCliCommand([
    "git", "arc", "wait", "--ref", "abc",
  ], gitOptions);
  assert.equal(wait.kind, "request");
  assert.deepEqual(wait.request.body, {
    action: "arcWait",
    checkpointCommit: "abc",
    cwd: "C:/workspace",
    harness: "codex",
    threadId: "thread-1",
  });
  assert.equal(wait.request.responseKind, "git-arc-wait");

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
    "git", "arc", "compare", "--ref", "proposal-one", "--", "src/file.ts",
  ], gitOptions);
  assert.equal(compare.kind, "request");
  assert.deepEqual(compare.request.body, {
    action: "compare",
    cwd: "C:/workspace",
    harness: "codex",
    paths: ["src/file.ts"],
    ref: "proposal-one",
    threadId: "thread-1",
  });
  assert.equal(compare.request.responseKind, "git-arc-compare");

  const checkpointDiff = await parseWorkbenchAgentCliCommand([
    "git", "arc", "diff",
  ], gitOptions);
  assert.equal(checkpointDiff.kind, "request");
  assert.equal(checkpointDiff.request.responseKind, "git-arc-diff");
  const pagedDiff = await parseWorkbenchAgentCliCommand([
    "git", "arc", "diff", "--page", "2",
  ], gitOptions);
  assert.equal(pagedDiff.kind, "request");
  assert.deepEqual(pagedDiff.request.body, {
    action: "diff",
    cwd: "C:/workspace",
    harness: "codex",
    page: 2,
    threadId: "thread-1",
  });
  assert.equal((await parseWorkbenchAgentCliCommand([
    "git", "arc", "diff", "--page", "2", "--", "src/file.ts",
  ], gitOptions)).kind, "error");

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

  const release = await parseWorkbenchAgentCliCommand(["git", "arc", "release"], gitOptions);
  assert.equal(release.kind, "request");
  assert.deepEqual(release.request.body, {
    action: "arcRelease",
    cwd: "C:/workspace",
    disown: false,
    harness: "codex",
    threadId: "thread-1",
  });
  assert.equal(release.request.responseKind, "git-arc-release");
  const disown = await parseWorkbenchAgentCliCommand(["git", "arc", "release", "--disown"], gitOptions);
  assert.equal(disown.kind, "request");
  assert.deepEqual(disown.request.body, { ...release.request.body, disown: true });

  const proposal = await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "--title", "Title", "--description", "Description",
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

  const titleDescriptionAmendment = await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "--amend", "proposal-one",
    "--title", "Replacement title", "--description", "Replacement description",
    "--fresh-title", "Fresh title", "--fresh-description", "Fresh description",
  ], gitOptions);
  assert.equal(titleDescriptionAmendment.kind, "request");
  assert.deepEqual(titleDescriptionAmendment.request.body, {
    action: "proposalCreate",
    amend: true,
    amendProposalId: "proposal-one",
    cwd: "C:/workspace",
    description: "Replacement description",
    freshDescription: "Fresh description",
    freshTitle: "Fresh title",
    harness: "codex",
    threadId: "thread-1",
    title: "Replacement title",
  });
  const messageOnlyAmendment = await parseWorkbenchAgentCliCommand([
    "git", "arc", "reword", "--proposal", "proposal-one",
    "--title", "Message-only title", "--description", "Message-only description",
  ], gitOptions);
  assert.equal(messageOnlyAmendment.kind, "request");
  assert.deepEqual(messageOnlyAmendment.request.body, {
    action: "proposalCreate",
    amend: false,
    amendProposalId: "proposal-one",
    cwd: "C:/workspace",
    description: "Message-only description",
    harness: "codex",
    threadId: "thread-1",
    title: "Message-only title",
  });
  assert.equal((await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "--amend", "--title", "Amend only",
  ], gitOptions)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "--amend", "proposal-one", "--title", "Targeted content amend", "--", "src/file.ts",
  ], gitOptions)).kind, "error");

  const bulletDescription = "- move thread Git out of Next\n- keep claims until index normalization succeeds\n- prevent optional explorer index writes";
  const bulletProposal = await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "--title", "Two-state Git acceptance", "--description", bulletDescription,
  ], gitOptions);
  assert.equal(bulletProposal.kind, "request");
  assert.equal(bulletProposal.request.body?.description, bulletDescription);

  const missingProposalTitle = await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "--title", "--description", "Description",
  ], gitOptions);
  assert.equal(missingProposalTitle.kind, "error");
  assert.match(missingProposalTitle.error, /--title requires a value/u);

  assert.equal((await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "-m", "Legacy title",
  ], gitOptions)).kind, "error");

  const replacementProposal = await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "--replace", "proposal-one", "--title", "Replacement",
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

  const ripgrep = await parseWorkbenchAgentCliCommand([
    "rg", "--", "-n", "a pattern with 'quotes'", "webapp",
  ], { cwd: "C:/workspace" });
  assert.equal(ripgrep.kind, "request");
  assert.deepEqual(ripgrep.request, {
    body: { args: ["-n", "a pattern with 'quotes'", "webapp"], cwd: "C:/workspace" },
    method: "POST",
    path: "/api/rg",
    responseKind: "native",
  });

  const ripgrepHelp = await parseWorkbenchAgentCliCommand(["rg", "--", "--help"], { cwd: "C:/workspace" });
  assert.equal(ripgrepHelp.kind, "request");
  assert.deepEqual(ripgrepHelp.request.body, { args: ["--help"], cwd: "C:/workspace" });

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
    ["request", "--url", "http://localhost:43210/api/file"],
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
});

test("routes canonical, compatibility, and leaf help to the nearest owning group", async () => {
  const canonicalRecall = await parseWorkbenchAgentCliCommand(["thread", "recall", "--help"]);
  const contextRecall = await parseWorkbenchAgentCliCommand(["thread", "context", "search", "--help"]);
  assert.deepEqual(contextRecall, canonicalRecall);

  const canonicalArc = await parseWorkbenchAgentCliCommand(["git", "arc", "--help"]);
  const arcLeaf = await parseWorkbenchAgentCliCommand(["git", "arc", "claims", "--help"]);
  assert.deepEqual(arcLeaf, canonicalArc);

  const browse = await parseWorkbenchAgentCliCommand(["browse", "--help"]);
  const browseLeaf = await parseWorkbenchAgentCliCommand(["browse", "run", "--help"]);
  assert.deepEqual(browseLeaf, browse);
});

test("maps composable reload switches to one deduplicated fixed request", async () => {
  const unmanaged = { callerThreadId: null, reloadCatalog };
  const parsed = await parseWorkbenchAgentCliCommand([
    "reload", "--server:codex", "--harness:opencode", "--server:codex",
    "--server:core+browse", "--server:opencode",
  ], unmanaged);
  if (parsed.kind === "error") throw new Error(parsed.error);
  assert.equal(parsed.kind, "request");
  if (parsed.kind !== "request") return;
  assert.deepEqual(parsed.request, {
    body: { scopes: ["server:codex", "harness:opencode", "server:core", "server:browse", "server:opencode"] },
    method: "POST",
    path: "/api/orchestrator/reload",
    responseKind: "orchestrator-reload",
    waitForReload: true,
  });
  assert.equal((await parseWorkbenchAgentCliCommand(["reload"], unmanaged)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["orchestrator", "reload", "--orchestrator-logic"], unmanaged)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand([
    "browse", "run", "--thread", "thread-1", "--command", "doctor", "--stream-progress",
  ])).kind, "error");
  const callerLaunched = await parseWorkbenchAgentCliCommand([
    "reload", "--server:topology", "--server:mcp",
  ], { callerHarness: "codex", callerThreadId: "thread-one", cwd: "C:/workspace", reloadCatalog });
  assert.equal(callerLaunched.kind, "request");
  if (callerLaunched.kind === "request") assert.deepEqual(callerLaunched.request.body, {
    scopes: ["server:topology", "server:mcp"],
  });
});

test("keeps reload and dirt hidden while direct reload help explains user ownership", async () => {
  const unmanaged = { callerThreadId: null, reloadCatalog };
  const parsed = await parseWorkbenchAgentCliCommand(["reload", "--all"], unmanaged);
  assert.equal(parsed.kind, "request", parsed.kind === "error" ? parsed.error : undefined);
  assert.deepEqual(parsed.request.body, { all: true });
  const unsafeAll = await parseWorkbenchAgentCliCommand(["reload", "--all", "--unsafe"], unmanaged);
  assert.equal(unsafeAll.kind, "request");
  if (unsafeAll.kind === "request") assert.deepEqual(unsafeAll.request.body, { all: true, unsafe: true });
  const explicitServer = await parseWorkbenchAgentCliCommand(["reload", "--harness:opencode"], unmanaged);
  assert.equal(explicitServer.kind, "request");
  if (explicitServer.kind === "request") {
    assert.deepEqual(explicitServer.request.body, {
      scopes: ["harness:opencode"],
    });
  }
  const hard = await parseWorkbenchAgentCliCommand(["reload", "--hard"], unmanaged);
  assert.equal(hard.kind, "request");
  if (hard.kind === "request") assert.deepEqual(hard.request.body, { scopes: ["server:process"] });
  assert.equal((await parseWorkbenchAgentCliCommand(["reload", "--hard", "--all"], unmanaged)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["reload", "--server:process"], unmanaged)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["reload", "--unsafe"], unmanaged)).kind, "error");
  assert.equal((await parseWorkbenchAgentCliCommand(["orchestrator", "reload", "--server:core"], unmanaged)).kind, "error");
  const reloadDefinition = listWorkbenchAgentCommands(reloadCatalog, "cli").find(({ words }) => words.join(" ") === "reload");
  assert.ok(reloadDefinition);
  assert.equal(reloadDefinition.hideFromMcp, true);
  assert.equal(reloadDefinition.hideFromRootHelp, true);
  assert.equal(reloadDefinition.inputSchema.safeParse({ scopes: ["server:mcp"] }).success, true);
  assert.equal(reloadDefinition.inputSchema.safeParse({ scopes: ["harness:codex"] }).success, true);
  const help = await parseWorkbenchAgentCliCommand(["--help"], unmanaged);
  assert.equal(help.kind, "help");
  if (help.kind === "help") {
    assert.doesNotMatch(help.help, /wb reload|wb dirt|--hard|--unsafe|server:process|harness:(?:codex|opencode)/u);
  }
  const reloadHelp = await parseWorkbenchAgentCliCommand(["reload", "--help"], unmanaged);
  assert.equal(reloadHelp.kind, "help");
  if (reloadHelp.kind === "help") {
    assert.match(reloadHelp.help, /--all/u);
    assert.match(reloadHelp.help, /wb reload \[--all \[--unsafe\] \| --<scope> \.\.\. \| --hard\]/u);
    assert.match(reloadHelp.help, /--server:core\+browse\+mcp/u);
    assert.match(reloadHelp.help, /--hard/u);
    assert.match(reloadHelp.help, /--unsafe/u);
    assert.match(reloadHelp.help, /--harness:codex/u);
    assert.match(reloadHelp.help, /--harness:opencode/u);
    assert.match(reloadHelp.help, /reloading is the responsibility of the user\. if you intend to do a reload, you should be operating with the user's permission\./u);
  }
});

test("runs the native shell transport and preserves the server response", async () => {
  const unusableTempPath = path.join(temporaryDirectoryPath, "not-a-directory");
  await writeFile(unusableTempPath, "The shell transport must not use this as a temp directory.", "utf8");
  const env = { ...process.env, TMPDIR: unusableTempPath, WORKBENCH_ORIGIN: origin };
  const result = await execFileAsync("bash", [
    shellSourcePath,
    "thread", "recall", "search", "--thread", "real-process", "--query", "needle", "--kind", "commentary",
  ], {
    cwd: temporaryDirectoryPath,
    env,
  });
  assert.match(result.stdout, /"ok":true/u);
  assert.equal(result.stderr, "");
  assert.equal(requests.at(-1)?.url, "/api/thread-context/real-process");
  assert.deepEqual(JSON.parse(requests.at(-1)?.body ?? "{}"), {
    action: "search",
    kinds: ["commentary"],
    query: "needle",
  });

  await assert.rejects(
    execFileAsync("bash", [shellSourcePath, "unsupported-command"], {
      cwd: temporaryDirectoryPath,
      env,
    }),
    (error: NodeJS.ErrnoException & { stderr?: string; stdout?: string }) => {
      assert.equal(error.stdout, "");
      assert.match(error.stderr ?? "", /Unsupported wb command: unsupported-command/u);
      assert.doesNotMatch(error.stderr ?? "", /mktemp|workbench-agent-response/u);
      return true;
    },
  );
});

test("streams hook stdin, preserves claim decisions, and allows transport failures", async () => {
  const env = {
    ...process.env,
    CODEX_THREAD_ID: "",
    WORKBENCH_HARNESS: "codex",
    WORKBENCH_ORIGIN: origin,
    WORKBENCH_THREAD_ID: "",
  };
  const hookArgs = [shellSourcePath, "__hook", "apply-patch-claim"];
  const hookInput = (filePath: string) => JSON.stringify({
    cwd: temporaryDirectoryPath,
    session_id: "hook-thread",
    tool_use_id: "patch-one",
    tool_input: { command: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-old\n+new\n*** End Patch` },
    tool_name: "apply_patch",
    turn_id: "turn-one",
  });
  const allowed = await execFileWithInput("bash", hookArgs, hookInput("claimed.ts"), {
    cwd: temporaryDirectoryPath,
    env,
  });
  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.stderr, "");
  assert.deepEqual(JSON.parse(allowed.stdout), {});

  const denied = await execFileWithInput("bash", hookArgs, hookInput("unclaimed.ts"), {
    cwd: temporaryDirectoryPath,
    env,
  });
  assert.equal(denied.exitCode, 0);
  assert.equal(denied.stderr, "");
  const deniedDecision = JSON.parse(denied.stdout) as { additionalContext?: string; hookSpecificOutput: { permissionDecision: string }; systemMessage?: string };
  assert.equal(deniedDecision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deniedDecision.systemMessage ?? "", /^workbench:file-change-failure:v1:/u);
  assert.equal(deniedDecision.additionalContext, undefined);

  const unavailable = await execFileWithInput("bash", hookArgs, hookInput("unavailable.ts"), {
    cwd: temporaryDirectoryPath,
    env,
  });
  assert.equal(unavailable.exitCode, 0);
  assert.equal(unavailable.stderr, "");
  assert.equal(JSON.parse(unavailable.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(unavailable.stdout).hookSpecificOutput.permissionDecisionReason, /claim registry unavailable/u);

  const disconnected = await execFileWithInput("bash", hookArgs, hookInput("claimed.ts"), {
    cwd: temporaryDirectoryPath,
    env: { ...env, WORKBENCH_ORIGIN: "http://127.0.0.1:1" },
  });
  assert.equal(disconnected.exitCode, 0);
  assert.match(disconnected.stderr, /curl:/u);
  assert.deepEqual(JSON.parse(disconnected.stdout), {});

  if (process.platform === "win32") {
    const shimDirectoryPath = path.join(temporaryDirectoryPath, "hook-shims");
    const shimEnv = { ...env };
    await new WorkbenchAgentCliEnvironment({
      origin,
      runtimeDirectoryPath: shimDirectoryPath,
      shellSourcePath,
    }).install(shimEnv);
    const nested = await execFileWithInput("C:\\Program Files\\PowerShell\\7\\pwsh.exe", [
      "-NoProfile", "-Command", "wb __hook apply-patch-claim",
    ], hookInput("unclaimed.ts"), {
      cwd: temporaryDirectoryPath,
      env: shimEnv,
    });
    assert.equal(nested.exitCode, 0, nested.stderr);
    assert.equal(nested.stderr, "");
    assert.equal(JSON.parse(nested.stdout).hookSpecificOutput.permissionDecision, "deny");
  }
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
  env.WORKBENCH_THREAD_ID = "";
  env.CODEX_THREAD_ID = "";
  reloadStatusReadCount = 0;
  const result = await execFileAsync(installed.windowsShimPath, [
    "reload", "--server:codex",
  ], {
    cwd: temporaryDirectoryPath,
    env,
    shell: true,
  });
  assert.equal(result.stdout, "Reload succeeded.\nApplied: server:codex\nQueued: none\n");
  const reloadPost = [...requests].reverse().find((request) => request.url === "/orchestrator/reload" && request.method === "POST");
  assert.deepEqual(JSON.parse(reloadPost?.body ?? "{}"), { scopes: ["server:codex"] });
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
    const cwdRuntimePath = path.join(workbenchRoot, "daemon", "node_modules", ".bin");
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
    stdout: "Task title set: Clean output\n",
  });
  assert.deepEqual(adapt("thread-title-get", { title: "Current task" }), {
    exitCode: 0,
    stderr: "",
    stdout: "Task title: Current task\n",
  });
  assert.deepEqual(adapt("thread-title-get", { title: "" }), {
    exitCode: 0,
    stderr: "",
    stdout: "No task title is set.\n",
  });
  assert.equal(adapt("thread-refresh", { accepted: true }).stdout, "Thread refresh scheduled.\n");
  const planRef = "a".repeat(40);
  const successorRef = "b".repeat(40);
  const planResponse = adapt("git-arc-plan", {
    checkpointCommit: planRef,
    intentName: "Polish arc UI",
    scopePaths: ["src/one.ts"],
    addedClaims: ["src/one.ts"],
  }, { action: "plan", paths: ["src/one.ts"] });
  assert.equal(parseGitArcReceipt(planResponse.stdout)?.plannedPathCount, 1);
  assert.deepEqual(parseGitArcReceipt(planResponse.stdout)?.additionalClaims, ["src/one.ts"]);
  assert.deepEqual(parseGitArcReceipt(planResponse.stdout)?.claimedPaths, []);
  const skippedPlanResponse = adapt("git-arc-plan", {
    checkpointCommit: planRef,
    intentName: "Skip generated output",
    scopePaths: ["src/one.ts"],
    skippedIgnoredPaths: ["tmp/a.ts", "tmp/b.ts", "tmp/c.ts"],
  }, { action: "plan", paths: ["src/one.ts", "tmp/a.ts", "tmp/b.ts", "tmp/c.ts"] });
  assert.match(
    skippedPlanResponse.stdout,
    /skipped gitignored 3\ntmp\/a\.ts\ntmp\/b\.ts\ntmp\/c\.ts/u,
  );
  assert.equal(adapt("git-arc-add", {
    kind: "noop",
    noOp: true,
    scopePaths: [],
    skippedIgnoredPaths: ["tmp/one.ts"],
  }, { action: "arcAdd", paths: ["tmp/one.ts"] }).stdout, (
    "skipped gitignored 1\ntmp/one.ts\n"
  ));
  assert.equal(adapt("git-arc-adopt", {
    kind: "noop",
    noOp: true,
    scopePaths: [],
    skippedIgnoredPaths: ["tmp/one.ts", "tmp/two.ts"],
  }, { action: "arcAdopt", paths: ["tmp/one.ts", "tmp/two.ts"] }).stdout, (
    "skipped gitignored 2\ntmp/one.ts\ntmp/two.ts\n"
  ));
  const driftResponse = adapt("git-arc-plan", {
    checkpointCommit: successorRef,
    intentName: "Polish arc UI",
    planningDrift: { previousRef: planRef, paths: ["src/one.ts", "src/two.ts"] },
    scopePaths: ["src/one.ts", "src/two.ts"],
  }, { action: "planAdd", paths: ["src/three.ts"] });
  assert.deepEqual(parseGitArcReceipt(driftResponse.stdout)?.planningDrift, [{ previousRef: planRef, paths: ["src/one.ts", "src/two.ts"] }]);
  const recovery = driftResponse.stdout.split("\n").find((line) => line.startsWith("git_arc_diff "))!;
  assert.deepEqual(JSON.parse(recovery.slice("git_arc_diff ".length)), { ref: planRef, paths: ["src/one.ts", "src/two.ts"] });
  const compareResponse = adapt("git-arc-compare", {
    changes: [],
    checkpointCommit: planRef,
    intentName: "Inspect arc",
    scopePaths: ["src/one.ts"],
    unclaimedDirtPaths: ["src/unclaimed.ts"],
  }, { action: "compare" });
  assert.match(compareResponse.stdout, /unclaimed dirt 1\nsrc\/unclaimed\.ts/u);
  const proposalCompareResponse = adapt("git-arc-compare", {
    changes: [],
    checkpointCommit: planRef,
    intentName: null,
    proposalId: "proposal-one",
    scopePaths: ["src/one.ts"],
    unclaimedDirtPaths: [],
  }, { action: "compare", ref: "proposal-one" });
  assert.equal(parseGitArcReceipt(proposalCompareResponse.stdout), null);
  const diffResponse = adapt("git-arc-diff", {
    checkpointCommit: planRef,
    diff: "diff --git a/src/one.ts b/src/one.ts\n",
    nextPage: 2,
    oversizedDiffPaths: ["src/giant.ts"],
    scopePaths: ["src/one.ts"],
    unclaimedDirtPaths: [],
  }, { action: "diff" });
  assert.ok(diffResponse.stdout.includes('git_arc_diff {"paths":["src/giant.ts"]}'));
  assert.ok(diffResponse.stdout.includes('next git_arc_diff {"page":2}'));
  const terminalDiffResponse = adapt("git-arc-diff", {
    checkpointCommit: planRef,
    diff: "diff --git a/src/final.ts b/src/final.ts\n",
    nextPage: null,
    oversizedDiffPaths: [],
    scopePaths: ["src/final.ts"],
    unclaimedDirtPaths: [],
  }, { action: "diff" });
  assert.match(terminalDiffResponse.stdout, /end diff/u);
  const releaseResponse = adapt("git-arc-release", {
    checkpointCommit: planRef,
    intentName: "Release owned work",
    releasedClaims: ["src/dirty.ts"],
    scopePaths: [],
  }, { action: "arcRelease", disown: true });
  assert.deepEqual(parseGitArcReceipt(releaseResponse.stdout)?.removedClaims, ["src/dirty.ts"]);
  assert.equal(parseGitArcReceipt(releaseResponse.stdout)?.claimedPathCount, 0);
  const waitResponse = adapt("git-arc-wait", {
    acquiredClaims: ["api:src/api.ts", "web:src/web.ts"],
    changes: [],
    checkpointCommit: planRef,
    intentName: "Wait and start",
    members: [
      { checkpointCommit: planRef, rootId: "api" },
      { checkpointCommit: successorRef, rootId: "web" },
    ],
    releasedClaims: [],
    scopePaths: ["api:src/api.ts", "web:src/web.ts"],
  }, { action: "arcWait" });
  assert.deepEqual(parseGitArcReceipt(waitResponse.stdout)?.additionalClaims, ["api:src/api.ts", "web:src/web.ts"]);
  assert.deepEqual(parseGitArcReceipt(waitResponse.stdout)?.memberRefs, [
      { ref: planRef, rootId: "api" },
      { ref: successorRef, rootId: "web" },
  ]);
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
  assert.equal(parseGitArcReceipt(movePreview.stdout)?.mode, "preview");
  assert.equal(parseGitArcReceipt(movePreview.stdout)?.remainingMatchCount, 2);
  assert.deepEqual(parseGitArcReceipt(movePreview.stdout)?.mappings, [{ destination: "tests/old.ts", source: "src/old.ts" }]);
  assert.equal(parseGitArcReceipt(adapt("git-arc-mv", {
    additionalClaims: ["tests/old.ts"], checkpointCommit: successorRef,
    mappings: [{ destination: "tests/old.ts", source: "src/old.ts" }],
    matchedPathCount: 1, mode: "applied", remainingMatchCount: 0, scopePaths: ["src/old.ts", "tests/old.ts"],
  }, { action: "arcMove" }).stdout)?.mode, "applied");
  assert.equal(parseGitArcReceipt(adapt("git-arc-propose", {
    proposalId: "proposal-one",
    sourceCheckpoint: successorRef,
  }).stdout)?.proposalId, "proposal-one");
  assert.match(adapt("git-arc-restore", {
    checkpointCommit: successorRef,
    restoredPaths: ["src/one.ts", "src/two.ts"],
  }, { paths: ["src/one.ts", "src/two.ts"] }).stdout, /restored 2\nsrc\/one.ts\nsrc\/two.ts/u);
  assert.match(adapt("git-arc-restore", {
    checkpointCommit: successorRef,
    restoredPaths: [],
  }, { paths: ["src/one.ts"] }).stdout, /restored 0/u);
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
  const empty = await parseWorkbenchAgentCliCommand(["git", "plan", "claims", "-m", "Draft"], gitArcOptions);
  assert.equal(empty.kind, "request");
  const adopted = await parseWorkbenchAgentCliCommand([
    "git", "plan", "claims", "-m", "Adopt dirt", "--", "*src/dirty-a.ts", "*src/dirty-b.ts", "src/clean.ts",
  ], gitArcOptions);
  assert.equal(adopted.kind, "request");
  assert.deepEqual(adopted.request.body, {
    action: "planClaims",
    inherit: false,
    start: false,
    roots: [],
    removePaths: [],
    adoptPaths: ["src/dirty-a.ts", "src/dirty-b.ts"],
    cwd: "C:/workspace",
    harness: "codex",
    intentName: "Adopt dirt",
    addPaths: ["src/clean.ts"],
    threadId: "thread-1",
  });
  const reloadPlan = await parseWorkbenchAgentCliCommand([
    "git", "plan", "claims", "-m", "Reload MCP", "--reload-scope", "server:mcp", "--", "src/clean.ts",
  ], gitArcOptions);
  assert.equal(reloadPlan.kind, "error");
  const add = await parseWorkbenchAgentCliCommand(["git", "plan", "claims", "--inherit", "--", "src/a.ts"], gitArcOptions);
  assert.equal(add.kind, "request");
  assert.deepEqual(add.request.body?.addPaths, ["src/a.ts"]);
  const remove = await parseWorkbenchAgentCliCommand(["git", "plan", "claims", "--inherit", "--", "-src/a.ts"], gitArcOptions);
  assert.equal(remove.kind, "request");
  assert.deepEqual(remove.request.body?.removePaths, ["src/a.ts"]);
  const adopt = await parseWorkbenchAgentCliCommand(["git", "plan", "claims", "--inherit", "--", "*src/a.ts"], gitArcOptions);
  assert.equal(adopt.kind, "request");
  assert.deepEqual(adopt.request.body?.adoptPaths, ["src/a.ts"]);
});

test("parses combined plan start and ref-free start", async () => {
  const combined = await parseWorkbenchAgentCliCommand([
    "git", "plan", "start", "-m", "Continue", "--", "*src/dirty.ts", "src/a.ts",
  ], gitArcOptions);
  assert.equal(combined.kind, "request");
  assert.equal(combined.request.body?.action, "planClaims");
  assert.equal(combined.request.body?.start, true);
  assert.deepEqual(combined.request.body?.adoptPaths, ["src/dirty.ts"]);
  const start = await parseWorkbenchAgentCliCommand(["git", "arc", "start"], gitArcOptions);
  assert.equal(start.kind, "request");
  assert.equal(start.request.body?.action, "arcStart");
});

test("parses explicit plan-ref diff and targeted amend", async () => {
  const diff = await parseWorkbenchAgentCliCommand(["git", "arc", "diff", "--ref", "abcdef1", "--", "src/a.ts"], gitArcOptions);
  assert.equal(diff.kind, "request");
  assert.equal(diff.request.body?.ref, "abcdef1");
  const amend = await parseWorkbenchAgentCliCommand([
    "git", "arc", "propose", "--amend", "proposal-one",
    "--title", "Replacement title", "--description", "Replacement description",
    "--fresh-title", "Fresh title", "--fresh-description", "Fresh description",
  ], gitArcOptions);
  assert.equal(amend.kind, "request");
  assert.equal(amend.request.body?.amendProposalId, "proposal-one");
  assert.equal(amend.request.body?.title, "Replacement title");
  assert.equal(amend.request.body?.description, "Replacement description");
  assert.equal(amend.request.body?.freshTitle, "Fresh title");
  assert.equal(amend.request.body?.freshDescription, "Fresh description");
});
