/* No production exports. Tests protect Codex instruction ownership, caller config preservation, and project-local MCP capability stamping. */
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

test("adapts managed thread methods and stamps only Workbench-root MCP clients", async () => {
  const root = "C:/git/web/workbench";
  const adapter = new WorkbenchCodexInstructionAdapter("ws://0.0.0.0:4500", root);
  const clientScopes = new Set<string>();

  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    const projectLocal = method === "thread/start";
    const result = await adapter.augment({
      method,
      params: {
        config: {
          bypass_hook_trust: false,
          existing_setting: "preserved",
          mcp_servers: { docs: { url: "https://example.com/mcp" } },
        },
        threadId: "thread",
      },
      workbenchPromptContext: {
        ...(projectLocal ? { cwd: root } : { cwd: "C:/other" }),
        instructionScope: "threadUtilities",
        threadId: "thread",
      },
    }, method);
    const config = (result.params as { config: Record<string, unknown> }).config;
    assert.equal(config.existing_setting, "preserved");
    assert.equal(config.bypass_hook_trust, true);
    assert.deepEqual((config.mcp_servers as Record<string, unknown>).docs, { url: "https://example.com/mcp" });
    const wb = (config.mcp_servers as { wb: Record<string, unknown> }).wb;
    const mcpUrl = new URL(String(wb.url));
    assert.equal(mcpUrl.origin, "http://127.0.0.1:4500");
    assert.equal(mcpUrl.pathname, "/orchestrator/mcp");
    assert.equal(mcpUrl.searchParams.get("project-local"), projectLocal ? "true" : null);
    clientScopes.add(mcpUrl.searchParams.get("client") ?? "");
  }
  assert.equal(clientScopes.size, 3);

  const unmarked = await adapter.augment({
    method: "thread/start",
    params: { config: { bypass_hook_trust: false, existing_setting: "preserved" } },
  }, "thread/start");
  assert.deepEqual(unmarked.params, { config: { bypass_hook_trust: false, existing_setting: "preserved" } });
});

test("configures internal Codex resumes from explicit or inherited cwd", () => {
  const adapter = new WorkbenchCodexInstructionAdapter("ws://127.0.0.1:4500", "C:/workbench");
  const local = adapter.createThreadResume({ threadId: "thread" }, { cwd: "C:/workbench", kind: "cwd" });
  const outside = adapter.createThreadResume({ threadId: "thread" }, { cwd: "C:/other", kind: "cwd" });
  const inherited = adapter.createThreadResume({ threadId: "thread" }, {
    kind: "request",
    request: {
      method: "turn/start",
      workbenchPromptContext: { cwd: "C:/workbench", instructionScope: "threadUtilities", threadId: "thread" },
    },
  });
  const readUrl = (request: JsonRpcRequest) => new URL(
    (request.params as { config: { mcp_servers: { wb: { url: string } } } }).config.mcp_servers.wb.url,
  );
  assert.equal(readUrl(local).searchParams.get("project-local"), "true");
  assert.equal(readUrl(outside).searchParams.get("project-local"), null);
  assert.equal(readUrl(inherited).searchParams.get("project-local"), "true");
  const inheritedContext = inherited.workbenchPromptContext as {
    cwd?: string;
    instructionScope?: string;
    threadId?: string;
  };
  assert.equal(inheritedContext.cwd, "C:/workbench");
  assert.equal(inheritedContext.instructionScope, "threadUtilities");
  assert.equal(inheritedContext.threadId, "thread");
});

test("delivers one fresh skill catalog with mentioned bodies preloaded", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-skill-catalog-"));
  const iteratePath = path.join(root, ".agents", "skills", "iterate", "SKILL.md");
  const brainstormPath = path.join(root, ".agents", "skills", "brainstorm", "SKILL.md");
  const iterateMarker = "PRELOADED ITERATE SKILL BODY";
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
  const promptContext = {
    mentionedSkillPaths: [iteratePath, iteratePath],
    cwd: root,
    harness: "codex" as const,
    instructionScope: "threadUtilities" as const,
    roots: [{ id: "project", isPrimary: true, name: "project", relativePath: "project", rootPath: root }],
    threadId: "thread",
  };
  const input = [{ text: "/iterate do the work", text_elements: [], type: "text" }];

  try {
    const bootstrap = await adapter.augment({
      method: "thread/start",
      params: {},
      workbenchPromptContext: {
        ...promptContext,
        mentionedSkillPaths: undefined,
        instructionScope: undefined,
      },
    }, "thread/start");
    const bootstrapParams = bootstrap.params as {
      baseInstructions?: string | null;
      developerInstructions?: string | null;
    };
    assert.doesNotMatch(bootstrapParams.baseInstructions ?? "", /Detected Workbench skills:/u);
    assert.doesNotMatch(bootstrapParams.developerInstructions ?? "", /Detected Workbench skills:/u);
    assert.doesNotMatch(bootstrapParams.baseInstructions ?? "", new RegExp(iterateMarker, "u"));
    assert.doesNotMatch(bootstrapParams.developerInstructions ?? "", new RegExp(iterateMarker, "u"));

    for (const method of ["turn/start", "turn/steer"] as const) {
      const result = await adapter.augment({
        method,
        params: {
          additionalContext: {
            existing: { kind: "application", value: "preserved" },
          },
          input,
        },
        workbenchPromptContext: promptContext,
      }, method);
      const params = result.params as {
        additionalContext: Record<string, { kind: string; value: string }>;
        input: unknown[];
      };
      assert.deepEqual(params.input, input);
      assert.deepEqual(params.additionalContext.existing, { kind: "application", value: "preserved" });
      assert.deepEqual(Object.keys(params.additionalContext).sort(), ["existing", "workbench_skills"]);
      const catalog = params.additionalContext.workbench_skills;
      assert.equal(catalog.kind, "application");
      assert.match(catalog.value, new RegExp(iterateMarker, "u"));
      assert.doesNotMatch(catalog.value, new RegExp(brainstormMarker, "u"));
      assert.doesNotMatch(catalog.value, /\nname: iterate\n/u);
      assert.ok(catalog.value.includes(
        `<skill filename="${iteratePath.replaceAll("\\", "/")}" trigger="Use when the user says /iterate &amp; the project allows it.">`,
      ));
      assert.ok(catalog.value.includes(
        `<skill filename="${brainstormPath.replaceAll("\\", "/")}" trigger="Use when the user says /brainstorm." />`,
      ));
    }

    const unmentioned = await adapter.augment({
      method: "turn/steer",
      params: { input },
      workbenchPromptContext: {
        ...promptContext,
        mentionedSkillPaths: undefined,
      },
    }, "turn/steer");
    const unmentionedCatalog = (unmentioned.params as {
      additionalContext: { workbench_skills: { value: string } };
    }).additionalContext.workbench_skills.value;
    assert.doesNotMatch(unmentionedCatalog, new RegExp(iterateMarker, "u"));
    assert.doesNotMatch(unmentionedCatalog, new RegExp(brainstormMarker, "u"));

    const rejected = await adapter.augment({
      method: "turn/steer",
      params: { input },
      workbenchPromptContext: {
        ...promptContext,
        mentionedSkillPaths: [path.join(root, "arbitrary.md")],
      },
    }, "turn/steer");
    const rejectedCatalog = (rejected.params as {
      additionalContext: { workbench_skills: { value: string } };
    }).additionalContext.workbench_skills.value;
    assert.doesNotMatch(rejectedCatalog, new RegExp(iterateMarker, "u"));
    assert.doesNotMatch(rejectedCatalog, new RegExp(brainstormMarker, "u"));
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
