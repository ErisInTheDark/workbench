/*
 * No production exports. Regression wards: every way an agent makes an external MCP call reaches the same skill matcher
 * with the same invocation, and Workbench's own tools never do.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import SkillMcpMatcherRuntime from "workbench-shared/workbench/skills/SkillMcpMatcherRuntime";
import type { JsonValue, ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

import { getThreadCommandDisplay, getWorkbenchMcpCommandDisplay } from "../thread-command-matchers";

let matchers: SkillMcpMatcherRuntime;
const seen: JsonValue[] = [];

before(async () => {
  const code = `var __wbSkillMcpMatchers = { default: [call => {
    if (call.server !== "azure-devops" || call.tool !== "pipelines_build") return null;
    return { verb: ["Listing", "Listed"], summary: ["builds", { code: call.arguments.buildIds.join(", ") }, "in", { code: call.arguments.project }],
      chip: { id: "builds", verb: "builds", icon: "git" }, component: "BuildList", props: { keep: call.keep, status: call.status } };
  }] };`;
  matchers = new SkillMcpMatcherRuntime(await newQuickJSWASMModuleFromVariant(variant), [{
    code, revision: createHash("sha256").update(code).digest("hex"), skillName: "devops", skillPath: "/skills/devops/SKILL.md",
  }], { onFailure: failure => seen.push(failure.message) });
});
after(() => matchers.dispose());

const args = { project: "Wayward", action: "list", buildIds: [23611] };

function mcp(server: string, tool: string, argumentsValue: JsonValue): Extract<ThreadItem, { type: "mcpToolCall" }> {
  return { id: `${server}-${tool}`, type: "mcpToolCall", server, tool, arguments: argumentsValue, status: "completed", result: null,
    error: null, durationMs: 1, appContext: null, pluginId: null, readOnlyHint: null };
}

function display(item: Extract<ThreadItem, { type: "mcpToolCall" }>) {
  return getWorkbenchMcpCommandDisplay({ argumentsValue: item.arguments, context: { skillMcpMatchers: matchers }, item, server: item.server, tool: item.tool });
}

test("direct calls, wb mcp_call and wb mcp call all present through the skill with one summary", () => {
  const direct = display(mcp("azure-devops", "pipelines_build", args));
  const wrapped = display(mcp("wb", "mcp_call", { server: "azure-devops", tool: "pipelines_build", arguments: args, keep: "b23611b", keepOnly: true }));
  const cli = getThreadCommandDisplay({
    command: `wb mcp call --server azure-devops --tool pipelines_build --arguments-json '${JSON.stringify(args)}' --keep b23611b`,
    commandActions: [], cwd: "C:/repo", projectRootPath: "C:/repo", skillMcpMatchers: matchers,
  });
  for (const shown of [direct, wrapped, cli]) {
    assert.equal(shown?.summaryText, "Listed builds 23611 in Wayward");
    assert.equal(shown?.skillMcp?.component, "BuildList");
    assert.equal(shown?.skillMcp?.chip?.verb, "builds");
  }
  // The kept name reaches the matcher only where the call kept its result; CLI text never knows the outcome.
  assert.deepEqual([direct, wrapped, cli].map(shown => shown?.skillMcp?.props), [
    { keep: null, status: "completed" }, { keep: "b23611b", status: "completed" }, { keep: "b23611b", status: null },
  ]);
  assert.deepEqual(seen, []);
});

test("Workbench's own tools and unparseable CLI arguments keep their ordinary presentation", () => {
  assert.equal(display(mcp("wb", "thread_recall", {}))?.skillMcp, undefined);
  assert.equal(display(mcp("wb", "mcp_call", { server: "wb", tool: "thread_recall", arguments: {} }))?.skillMcp, undefined);
  const cli = getThreadCommandDisplay({
    command: "wb mcp call --server azure-devops --tool pipelines_build --arguments-json '{oops'", commandActions: [], cwd: "C:/repo", skillMcpMatchers: matchers,
  });
  assert.equal(cli.skillMcp, undefined);
  assert.match(cli.summaryText, /pipelines build/iu);
});
