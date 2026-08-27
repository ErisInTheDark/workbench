/* No production exports. Tests protect Codex instruction ownership, caller config preservation, and project-local MCP capability stamping. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonRpcRequest } from "./bridge-types";
import WorkbenchCodexInstructionAdapter from "./WorkbenchCodexInstructionAdapter";

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
