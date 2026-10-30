import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";

import type { SkillMcpCall, SkillMcpMatcherBundle } from "./skill-mcp-matcher-contract.ts";
import SkillMcpMatcherRuntime, { type SkillMcpMatchFailure } from "./SkillMcpMatcherRuntime.ts";

let module: QuickJSWASMModule;
const runtimes: SkillMcpMatcherRuntime[] = [];

before(async () => { module = await newQuickJSWASMModuleFromVariant(variant); });
after(() => { for (const runtime of runtimes) runtime.dispose(); });

/** A bundle as the compiler emits it: matchers assigned to the global the prelude reads. */
function bundle(skillName: string, matchers: string): SkillMcpMatcherBundle {
  const code = `var __wbSkillMcpMatchers = { default: [${matchers}] };`;
  return { skillName, skillPath: `/skills/${skillName}/SKILL.md`, revision: createHash("sha256").update(code).digest("hex"), code };
}

function runtime(bundles: SkillMcpMatcherBundle[], failures: SkillMcpMatchFailure[] = []) {
  const created = new SkillMcpMatcherRuntime(module, bundles, { onFailure: failure => failures.push(failure) });
  runtimes.push(created);
  return created;
}

const call: SkillMcpCall = {
  server: "azure-devops", tool: "pipelines_build", arguments: { action: "list", project: "Wayward", buildIds: [23611] },
  keep: null, status: "completed", error: null, result: null,
};

const listBuilds = `call => call.tool === "pipelines_build" && call.arguments.action === "list"
  ? { verb: ["Listing", "Listed"], summary: ["builds", { code: call.arguments.buildIds.join(", ") }, "in", { code: call.arguments.project }],
      chip: { id: "builds", verb: "builds", icon: "git" } }
  : null`;

test("the first active skill presenting a call wins, and skills returning null pass it on", () => {
  const matchers = runtime([bundle("other", "() => null"), bundle("devops", listBuilds), bundle("late", `() => ({ verb: ["A", "B"] })`)]);
  const match = matchers.match(call);
  assert.equal(match?.skillName, "devops");
  assert.deepEqual(match?.presentation.summary, ["builds", { code: "23611" }, "in", { code: "Wayward" }]);
  assert.equal(match?.presentation.display, "step");
  assert.equal(matchers.match({ ...call, server: "elsewhere", tool: "other" })?.skillName, "late");
});

test("a throwing matcher fails only its call and is reported once", () => {
  const failures: SkillMcpMatchFailure[] = [];
  const matchers = runtime([bundle("flaky", `call => { if (call.arguments.action === "list") throw new Error("nope"); return null; }`), bundle("devops", listBuilds)], failures);
  assert.equal(matchers.match(call)?.skillName, "devops");
  assert.equal(matchers.match(call)?.skillName, "devops");
  assert.equal(matchers.match({ ...call, arguments: { action: "queue" } }), null);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.message, /threw: Error: nope/u);
});

test("a runaway matcher stops answering instead of freezing its host", () => {
  const failures: SkillMcpMatchFailure[] = [];
  const matchers = runtime([bundle("loop", "() => { for (;;) {} }"), bundle("devops", listBuilds)], failures);
  assert.equal(matchers.match(call)?.skillName, "devops");
  assert.match(failures[0]!.message, /Matcher stopped/u);
  const started = Date.now();
  assert.equal(matchers.match(call)?.skillName, "devops");
  assert.ok(Date.now() - started < 25, "a stopped matcher is skipped without running again");
});

test("output outside the presentation contract is rejected with its reason", () => {
  const failures: SkillMcpMatchFailure[] = [];
  const matchers = runtime([bundle("bad", `() => ({ verb: ["Listing", "Listed"], display: { card: "Not Valid" } })`)], failures);
  const report = matchers.report(call);
  assert.equal(report.match, null);
  assert.match(report.failures[0]!.message, /Matcher output is invalid/u);
});

test("a bundle without a matcher export reports a load failure", () => {
  const matchers = runtime([{ ...bundle("empty", ""), code: "var __wbSkillMcpMatchers = { default: 4 };" }]);
  assert.match(matchers.report(call).failures[0]!.message, /failed to load: .*defineMcpMatcher/u);
});
