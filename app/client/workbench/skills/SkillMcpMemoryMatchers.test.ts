/* No production exports. Protect matcher memory: transcript-order folding, per-skill isolation, refolds that rerun only calls whose memory changed, and the size cap. */
import assert from "node:assert/strict";
import test from "node:test";
import type { SkillMcpCall, SkillMcpMemory, SkillMcpPresentation } from "workbench-shared/workbench/skills/skill-mcp-matcher-contract";
import type { SkillMcpMatchers, SkillMcpMatchOptions } from "workbench-shared/workbench/skills/SkillMcpMatcherRuntime";
import SkillMcpMemoryMatchers from "./SkillMcpMemoryMatchers";

const call = (tool: string, args: Record<string, string> = {}): SkillMcpCall => ({
  server: "composio", tool, arguments: args, keep: null, status: "completed", error: null, result: null,
});

/**
 * Two skills: `trello` remembers card names on add and reads them on member calls; `other` only reads. Records every
 * call it runs, so tests see which calls matched again.
 */
function trelloMatchers() {
  const runs: string[] = [];
  const matchers: SkillMcpMatchers = {
    key: "base",
    match(input: SkillMcpCall, { memory }: SkillMcpMatchOptions = {}) {
      const args = input.arguments as Record<string, string>;
      runs.push(`${input.tool}:${args.id ?? ""}`);
      const own = (skill: string): SkillMcpMemory => memory?.get(skill) ?? {};
      const presented = (skillPath: string, presentation: Partial<SkillMcpPresentation>) => ({
        skillName: skillPath, skillPath, presentation: { verb: ["a", "b"] as [string, string], summary: [], display: "step" as const, ...presentation },
      });
      if (input.tool === "add") return presented("trello", { remember: { [`card:${args.id}`]: args.name ?? "" } });
      if (input.tool === "member") return presented("trello", { summary: [JSON.stringify(own("trello")[`card:${args.id}`] ?? null)] });
      if (input.tool === "peek") return presented("other", { summary: [JSON.stringify(own("other"))] });
      return null;
    },
  };
  return { matchers, runs };
}

const summaryOf = (matchers: SkillMcpMatchers, identity: object, input: SkillMcpCall) => matchers.match(input, { identity })?.presentation.summary[0];

test("a later call reads what earlier calls of its skill remembered, and nothing of other skills", () => {
  const { matchers } = trelloMatchers();
  const add = { id: "add" }, member = { id: "member" }, peek = { id: "peek" }, early = { id: "early" };
  const calls = [
    { identity: early, call: call("member", { id: "c1" }) },
    { identity: add, call: call("add", { id: "c1", name: "Fix dialogs" }) },
    { identity: member, call: call("member", { id: "c1" }) },
    { identity: peek, call: call("peek") },
  ];
  const folded = new SkillMcpMemoryMatchers(matchers, calls);
  assert.equal(summaryOf(folded, early, calls[0]!.call), "null", "memory never leaks backwards");
  assert.equal(summaryOf(folded, member, calls[2]!.call), "\"Fix dialogs\"");
  assert.equal(summaryOf(folded, peek, calls[3]!.call), "{}");
});

test("loading older history reruns only calls whose memory changed, and an unchanged rerun stops the cascade", () => {
  const { matchers, runs } = trelloMatchers();
  const add = { id: "add" }, member = { id: "member" }, peek = { id: "peek" }, older = { id: "older" };
  const loaded = [
    { identity: add, call: call("add", { id: "c1", name: "Fix dialogs" }) },
    { identity: member, call: call("member", { id: "c1" }) },
    { identity: peek, call: call("peek") },
  ];
  const first = new SkillMcpMemoryMatchers(matchers, loaded);
  runs.length = 0;
  const appended = new SkillMcpMemoryMatchers(matchers, [...loaded, { identity: { id: "new" }, call: call("unrelated") }], first);
  assert.deepEqual(runs, ["unrelated:"], "appending reuses every earlier answer");

  runs.length = 0;
  const withOlder = new SkillMcpMemoryMatchers(matchers, [{ identity: older, call: call("add", { id: "c0", name: "Old" }) }, ...loaded], appended);
  assert.deepEqual(runs, ["add:c0", "add:c1", "member:c1"], "only trello calls rerun; the other skill's call keeps its answer");
  assert.equal(summaryOf(withOlder, member, loaded[1]!.call), "\"Fix dialogs\"");

  runs.length = 0;
  new SkillMcpMemoryMatchers(matchers, [{ identity: { id: "older-again" }, call: call("unrelated") }, ...loaded], first);
  assert.deepEqual(runs, ["unrelated:"], "a refold whose memory comes out the same reruns nothing after it");
});

test("a skill's memory keeps its newest facts within the cap", () => {
  const { matchers } = trelloMatchers();
  const big = "x".repeat(20_000);
  const calls = ["a", "b", "c", "d"].map(id => ({ identity: { id }, call: call("add", { id, name: big }) }));
  const probe = { identity: { id: "probe" }, call: call("member", { id: "a" }) };
  const latest = { identity: { id: "latest" }, call: call("member", { id: "d" }) };
  const folded = new SkillMcpMemoryMatchers(matchers, [...calls, probe, latest]);
  assert.equal(summaryOf(folded, probe.identity, probe.call), "null", "the oldest fact left first");
  assert.equal(summaryOf(folded, latest.identity, latest.call), JSON.stringify(big));
});
