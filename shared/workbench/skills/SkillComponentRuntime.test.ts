/* No production exports. Protect sandboxed component rendering: attributes, kept results, nesting and runaway isolation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";

import { readThreadComponentMarkup } from "../thread/thread-component-markup.ts";
import type { SkillComponentBundle } from "./skill-component-contract.ts";
import SkillComponentRuntime from "./SkillComponentRuntime.ts";

let module: QuickJSWASMModule;
const runtimes: SkillComponentRuntime[] = [];

before(async () => { module = await newQuickJSWASMModuleFromVariant(variant); });
after(() => { for (const runtime of runtimes) runtime.dispose(); });

/** A bundle as the compiler emits it: each component's default export assigned by name. */
function bundle(skillName: string, components: Record<string, string>): SkillComponentBundle {
  const code = `globalThis.__wbSkillComponents = { ${Object.entries(components).map(([name, source]) => `${name}: ${source}`).join(", ")} };`;
  return {
    skillName, skillPath: `/skills/${skillName}/SKILL.md`, components: Object.keys(components),
    revision: createHash("sha256").update(code).digest("hex"), code,
  };
}

/** Block-level invocations only, as the client's markdown parser reports them. */
const nestedInvocations = (markdown: string) => markdown.split("\n").flatMap(line => {
  const parsed = readThreadComponentMarkup(line.trim());
  return parsed && parsed.end === line.trim().length ? [parsed.source] : [];
});

function runtime(bundles: SkillComponentBundle[]) {
  const created = new SkillComponentRuntime(module, bundles, { nestedInvocations });
  runtimes.push(created);
  return created;
}

const el = (type: string, props: object) => ({ $workbench: "element", type, props });

const board = bundle("trello", {
  Board: `props => ({ $workbench: "element", type: "div", props: { children: props.cards.map(card => card.name).join(","), title: props.title, open: props.open } })`,
  Shell: `props => ({ $workbench: "element", type: "section", props: { children: props.children } })`,
});

test("invocation attributes evaluate as expressions, text and flags", () => {
  const tree = runtime([board]).render({ kind: "markup", markup: `<Board cards={[{ name: "a" }, { name: "b" }]} title="x &amp; y" open />`, results: {} });
  assert.deepEqual(tree, el("div", { children: "a,b", title: "x & y", open: true }));
});

test("kept results replace their references, and a missing one says which", () => {
  const components = runtime([board]);
  assert.deepEqual(
    components.render({ kind: "markup", markup: `<Board cards="@result:cards" />`, results: { cards: [{ name: "kept" }] } }),
    el("div", { children: "kept" }),
  );
  assert.throws(() => components.render({ kind: "markup", markup: `<Board cards="@result:gone" />`, results: {} }), /No kept MCP result named gone/u);
});

test("a body's nested invocations resolve into its markdown node", () => {
  const tree = runtime([board]).render({ kind: "markup", markup: `<Shell>\nintro\n<Board cards={[{ name: "n" }]} />\n</Shell>`, results: {} });
  assert.deepEqual(tree, el("section", { children: el("workbench:markdown", {
    source: `intro\n<Board cards={[{ name: "n" }]} />`,
    components: { [`<Board cards={[{ name: "n" }]} />`]: el("div", { children: "n" }) },
  }) }));
});

test("call components render straight from props, only from the skill presenting them", () => {
  const components = runtime([board]);
  assert.deepEqual(components.render({ kind: "props", skillPath: board.skillPath, component: "Board", props: { cards: [{ name: "c" }] } }), el("div", { children: "c" }));
  assert.throws(() => components.render({ kind: "props", skillPath: "/elsewhere", component: "Board", props: {} }), /not active/u);
  assert.throws(() => components.render({ kind: "markup", markup: "<Missing />", results: {} }), /No active skill exposes component Missing/u);
});

test("attribute expressions cannot reach a skill's components", () => {
  const components = runtime([board]);
  assert.throws(() => components.render({ kind: "markup", markup: `<Board cards={(globalThis.__wbSkillComponents.Board = 1, [])} />`, results: {} }), /attributes failed/u);
  assert.deepEqual(components.render({ kind: "markup", markup: `<Board cards={[]} />`, results: {} }), el("div", { children: "" }));
});

test("output must be a safe serializable tree", () => {
  const unsafe = runtime([bundle("bad", {
    Fn: `() => ({ $workbench: "element", type: "div", props: { onClick: () => 1 } })`,
    Script: `() => ({ $workbench: "element", type: "script", props: {} })`,
  })]);
  assert.throws(() => unsafe.render({ kind: "markup", markup: "<Fn />", results: {} }), /non-serializable/u);
  assert.throws(() => unsafe.render({ kind: "markup", markup: "<Script />", results: {} }), /Unsupported component element/u);
});

test("a runaway render fails alone and leaves its skill's other components working", () => {
  const components = runtime([bundle("loop", {
    Spin: `() => { const deeper = depth => deeper(depth + 1); return deeper(0); }`,
    Fine: `() => ({ $workbench: "element", type: "p", props: { children: "ok" } })`,
  })]);
  assert.throws(() => components.render({ kind: "markup", markup: "<Spin />", results: {} }), /Spin stopped/u);
  assert.deepEqual(components.render({ kind: "markup", markup: "<Fine />", results: {} }), el("p", { children: "ok" }));
});

test("its key changes exactly when a bundle's code does", () => {
  const same = bundle("trello", { Board: "() => null" });
  assert.equal(SkillComponentRuntime.keyOf([same]), SkillComponentRuntime.keyOf([bundle("trello", { Board: "() => null" })]));
  assert.notEqual(SkillComponentRuntime.keyOf([same]), SkillComponentRuntime.keyOf([bundle("trello", { Board: "() => 1" })]));
});
