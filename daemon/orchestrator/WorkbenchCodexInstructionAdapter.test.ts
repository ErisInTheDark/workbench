/*
 * No production exports. Tests protect stable Codex thread instructions, fresh filtered project rules, per-input activated skills, caller config preservation, and project-local MCP capability stamping.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { JsonRpcRequest } from "./bridge-types";

const originalWorkbenchLibraryRoot = process.env.WORKBENCH_LIBRARY_ROOT;
let testWorkbenchLibraryRoot = "";
let WorkbenchCodexInstructionAdapter: (typeof import("./WorkbenchCodexInstructionAdapter.js"))["default"];

before(async () => {
  testWorkbenchLibraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-instruction-library-"));
  process.env.WORKBENCH_LIBRARY_ROOT = testWorkbenchLibraryRoot;
  WorkbenchCodexInstructionAdapter = (await import("./WorkbenchCodexInstructionAdapter.js")).default as unknown as (
    typeof WorkbenchCodexInstructionAdapter
  );
});

after(async () => {
  if (originalWorkbenchLibraryRoot === undefined) delete process.env.WORKBENCH_LIBRARY_ROOT;
  else process.env.WORKBENCH_LIBRARY_ROOT = originalWorkbenchLibraryRoot;
  await fs.rm(testWorkbenchLibraryRoot, { force: true, recursive: true });
});

function readPromptInstructions(request: JsonRpcRequest) {
  const params = request.params as {
    baseInstructions?: string | null;
    developerInstructions?: string | null;
  };
  return {
    baseInstructions: params.baseInstructions ?? null,
    developerInstructions: params.developerInstructions ?? null,
  };
}

test("context settings configure thread admission without leaking unsupported config into turns", () => {
  const adapter = new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", process.cwd());
  const configuration = {
    cwd: process.cwd(), projectId: "project", roots: [], subagentName: null, threadId: "thread",
    settings: { agentPath: null, agentSource: null, harness: "codex" as const, model: "model", reasoningEffort: null, serviceTier: null, contextWindowTokens: 600_000 },
  };
  for (const method of ["thread/start", "thread/resume"]) {
    const configured = adapter.withThreadConfiguration({ method, params: { config: { unrelated: true } } }, configuration);
    const config = (configured.params as { config: Record<string, number | boolean> }).config;
    assert.equal(config.model_context_window, 600_000);
    assert.equal(config.model_auto_compact_token_limit, 540_000);
    assert.equal(config.unrelated, true);
  }
  const turn = adapter.withThreadConfiguration({ method: "turn/start", params: { input: [] } }, configuration);
  assert.equal("config" in (turn.params as object), false);
});

test("daemon thread configuration replaces stale caller settings while preserving message intent", () => {
  const adapter = new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:1", process.cwd());
  const input = [{ type: "text", text: "answer", text_elements: [] }];
  const result = adapter.withThreadConfiguration({
    method: "turn/start",
    params: { input, model: "stale", serviceTier: "fast", effort: "high", collaborationMode: { mode: "plan", settings: { model: "stale", reasoning_effort: "high" } } },
    workbenchPromptContext: { agentPath: "wrong.md", cwd: "wrong", projectId: "wrong", activatedSkillPaths: ["skill.md"], workflowIds: ["custom"] },
  }, {
    cwd: process.cwd(), projectId: "owned", roots: [], threadId: "thread", subagentName: null,
    settings: { agentPath: null, agentSource: null, harness: "codex", model: "owned-model", reasoningEffort: null, serviceTier: null },
  });
  const params = result.params as Record<string, unknown>;
  assert.equal(params.model, "owned-model");
  assert.equal(params.serviceTier, null);
  assert.equal(params.effort, null);
  assert.deepEqual(params.input, input);
  assert.deepEqual(params.collaborationMode, { mode: "plan", settings: { model: "owned-model", reasoning_effort: null } });
  const context = result.workbenchPromptContext as Record<string, unknown>;
  assert.equal(context.agentPath, null);
  assert.equal(context.cwd, process.cwd());
  assert.equal(context.projectId, "owned");
  assert.deepEqual(context.activatedSkillPaths, ["skill.md"]);
  assert.deepEqual(context.workflowIds, ["custom"]);
});

test("start, resume, and fork rebuild one filtered project prefix and disable native project docs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-project-instructions-"));
  const adapter = new WorkbenchCodexInstructionAdapter("ws://0.0.0.0:4500", root);
  const clientScopes = new Set<string>();
  const prompts: ReturnType<typeof readPromptInstructions>[] = [];
  const roots = [{ id: "project", isPrimary: true, name: "project", relativePath: "project", rootPath: root }];

  try {
    await fs.writeFile(
      path.join(root, "AGENTS.md"),
      "project root\n<!-- source-only note -->\n{./project-rule}\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, "project-rule.md"), "project rule revision one\n", "utf8");

    for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
      const result = await adapter.augment({
        method,
        params: {
          config: {
            bypass_hook_trust: false,
            existing_setting: "preserved",
            mcp_servers: { docs: { url: "https://example.com/mcp" } },
            project_doc_max_bytes: 65_536,
          },
          threadId: "thread",
        },
        workbenchPromptContext: {
          cwd: root,
          instructionScope: "threadUtilities",
          roots,
          threadId: "thread",
        },
      }, method);
      prompts.push(readPromptInstructions(result));
      const config = (result.params as { config: Record<string, unknown> }).config;
      assert.equal(config.existing_setting, "preserved");
      assert.equal(config.bypass_hook_trust, true);
      assert.equal(config.developer_instructions, "");
      assert.equal(config.instructions, "");
      assert.equal(config.project_doc_max_bytes, 0);
      assert.deepEqual((config.mcp_servers as Record<string, unknown>).docs, { url: "https://example.com/mcp" });
      const workbenchServers = config.mcp_servers as {
        wb: Record<string, unknown>;
        wbex: Record<string, unknown>;
      };
      for (const server of [workbenchServers.wb, workbenchServers.wbex]) {
        const mcpUrl = new URL(String(server.url));
        assert.equal(mcpUrl.origin, "http://127.0.0.1:4500");
        assert.equal(mcpUrl.pathname, "/orchestrator/mcp");
        assert.equal(mcpUrl.searchParams.get("project-local"), "true");
        clientScopes.add(mcpUrl.searchParams.get("client") ?? "");
      }
    }
    assert.deepEqual(prompts[1], prompts[0]);
    assert.deepEqual(prompts[2], prompts[0]);
    assert.equal(clientScopes.size, 6);

    const developerInstructions = prompts[0]?.developerInstructions ?? "";
    assert.equal(developerInstructions.split("<project_instructions>").length - 1, 1);
    assert.match(
      developerInstructions,
      /Apply the following project instructions at user-level priority\. They do not override system or developer instructions\.\n<project_instructions>\nproject root[\s\S]*project rule revision one\n<\/project_instructions>/u,
    );
    assert.doesNotMatch(developerInstructions, /source-only note|\{\.\/project-rule\}/u);

    await fs.writeFile(path.join(root, "project-rule.md"), "project rule revision two\n", "utf8");
    const refreshed = await adapter.augment({
      method: "thread/resume",
      params: { threadId: "thread" },
      workbenchPromptContext: { cwd: root, roots, threadId: "thread" },
    }, "thread/resume");
    assert.match(readPromptInstructions(refreshed).developerInstructions ?? "", /project rule revision two/u);
    assert.doesNotMatch(readPromptInstructions(refreshed).developerInstructions ?? "", /project rule revision one/u);

    const unmarked = await adapter.augment({
      method: "thread/start",
      params: {
        config: {
          bypass_hook_trust: false,
          existing_setting: "preserved",
          project_doc_max_bytes: 65_536,
        },
      },
    }, "thread/start");
    assert.deepEqual(unmarked.params, {
      config: {
        bypass_hook_trust: false,
        existing_setting: "preserved",
        project_doc_max_bytes: 65_536,
      },
    });
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("internal resume inherits the full prompt context from its triggering request", async () => {
  const adapter = new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:4500", "C:/workbench");
  const local = adapter.createThreadResume({ threadId: "thread" }, { cwd: "C:/workbench", kind: "cwd" });
  const outside = adapter.createThreadResume({ threadId: "thread" }, { cwd: "C:/other", kind: "cwd" });
  const triggeringRequest: JsonRpcRequest = {
    method: "turn/start",
    workbenchPromptContext: { cwd: "C:/workbench", threadId: "thread" },
  };
  const inherited = adapter.createThreadResume({ threadId: "thread" }, {
    kind: "request",
    request: triggeringRequest,
  });
  const readUrls = (request: JsonRpcRequest) => {
    const servers = (request.params as {
      config: { mcp_servers: { wb: { url: string }; wbex: { url: string } } };
    }).config.mcp_servers;
    return [new URL(servers.wb.url), new URL(servers.wbex.url)];
  };
  readUrls(local).forEach((url) => assert.equal(url.searchParams.get("project-local"), "true"));
  readUrls(outside).forEach((url) => assert.equal(url.searchParams.get("project-local"), null));
  readUrls(inherited).forEach((url) => assert.equal(url.searchParams.get("project-local"), "true"));
  const inheritedContext = inherited.workbenchPromptContext as Record<string, unknown>;
  assert.equal(inheritedContext.cwd, "C:/workbench");
  assert.equal(inheritedContext.threadId, "thread");
  assert.equal(inheritedContext.instructionScope, undefined);

  const directResume = await adapter.augment({
    method: "thread/resume",
    params: { threadId: "thread" },
    workbenchPromptContext: triggeringRequest.workbenchPromptContext,
  }, "thread/resume");
  const internalResume = await adapter.augment(inherited, "thread/resume");
  assert.deepEqual(readPromptInstructions(internalResume), readPromptInstructions(directResume));
});

test("normal prompts stay compact while triggering turn inputs receive fresh activated bodies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-skill-catalog-"));
  const iteratePath = path.join(root, ".agents", "skills", "iterate", "SKILL.md");
  const brainstormPath = path.join(root, ".agents", "skills", "brainstorm", "SKILL.md");
  const iterateMarker = "FRESH ITERATE SKILL BODY";
  const revisedIterateMarker = "REVISED ITERATE SKILL BODY";
  const brainstormMarker = "INACTIVE BRAINSTORM SKILL BODY";
  await fs.mkdir(path.dirname(iteratePath), { recursive: true });
  await fs.mkdir(path.dirname(brainstormPath), { recursive: true });
  await fs.writeFile(iteratePath, `---
name: iterate
description: Use when the user says /iterate & the project allows it.
---

${iterateMarker}
`, "utf8");
  await fs.writeFile(brainstormPath, `---
name: brainstorm
description: Use when the user says /brainstorm.
---

${brainstormMarker}
`, "utf8");

  const adapter = new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:4500", root);
  const roots = [{ id: "project", isPrimary: true, name: "project", relativePath: "project", rootPath: root }];
  const promptContext = {
    activatedSkillPaths: [iteratePath, iteratePath],
    cwd: root,
    harness: "codex" as const,
    roots,
    threadId: "thread",
  };
  const input = [{ text: "/iterate do the work", text_elements: [], type: "text" as const }];

  try {
    const bootstrap = await adapter.augment({
      method: "thread/start",
      params: {},
      workbenchPromptContext: { ...promptContext, activatedSkillPaths: undefined },
    }, "thread/start");
    const instructions = [
      readPromptInstructions(bootstrap).baseInstructions ?? "",
      readPromptInstructions(bootstrap).developerInstructions ?? "",
    ].join("\n");
    assert.doesNotMatch(instructions, new RegExp(iterateMarker, "u"));
    assert.doesNotMatch(instructions, new RegExp(brainstormMarker, "u"));
    assert.ok(instructions.includes(
      `<skill filename="${iteratePath.replaceAll("\\", "/")}" trigger="Use when the user says /iterate &amp; the project allows it." />`,
    ));
    assert.ok(instructions.includes(
      `<skill filename="${brainstormPath.replaceAll("\\", "/")}" trigger="Use when the user says /brainstorm." />`,
    ));
    assert.equal(instructions.split("<workbench_skills>").length - 1, 1);

    for (const method of ["turn/start", "turn/steer"] as const) {
      const collaborationMode = {
        mode: "plan",
        settings: { developer_instructions: "", model: "gpt-test", reasoning_effort: null },
      };
      const result = await adapter.augment({
        method,
        params: {
          additionalContext: {
            existing: { kind: "application", value: "preserved" },
          },
          collaborationMode,
          input,
        },
        workbenchPromptContext: promptContext,
      }, method);
      const params = result.params as {
        additionalContext: Record<string, { kind: string; value: string }>;
        collaborationMode: typeof collaborationMode;
        input: Array<{ text: string; type: string }>;
      };
      assert.deepEqual(params.input[0], input[0]);
      assert.equal(params.input.length, 2);
      assert.deepEqual(params.additionalContext, {
        existing: { kind: "application", value: "preserved" },
      });
      assert.deepEqual(params.collaborationMode, collaborationMode);
      const activatedInput = params.input[1]?.text ?? "";
      assert.match(activatedInput, /^<wb:activated-skills>\n/u);
      assert.match(activatedInput, new RegExp(iterateMarker, "u"));
      assert.doesNotMatch(activatedInput, new RegExp(brainstormMarker, "u"));
      assert.doesNotMatch(activatedInput, /\nname: iterate\n/u);
      assert.ok(activatedInput.includes(
        `<skill filename="${iteratePath.replaceAll("\\", "/")}" trigger="Use when the user says /iterate &amp; the project allows it.">`,
      ));
    }

    await fs.writeFile(iteratePath, `---
name: iterate
description: Use when the user says /iterate.
---

${revisedIterateMarker}
`, "utf8");
    const repeated = await adapter.augment({
      method: "turn/steer",
      params: { input },
      workbenchPromptContext: promptContext,
    }, "turn/steer");
    const repeatedInput = (repeated.params as { input: Array<{ text: string }> }).input[1]?.text ?? "";
    assert.match(repeatedInput, new RegExp(revisedIterateMarker, "u"));
    assert.doesNotMatch(repeatedInput, new RegExp(iterateMarker, "u"));

    for (const activatedSkillPaths of [undefined, [path.join(root, "arbitrary.md")]]) {
      const request = {
        method: "turn/steer",
        params: { input },
        workbenchPromptContext: { ...promptContext, activatedSkillPaths },
      };
      assert.deepEqual(await adapter.augment(request, "turn/steer"), request);
    }
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
