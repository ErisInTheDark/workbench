/* No production exports. Protect TSX template evaluation with the props from chat markup. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import { projectRoot } from "../shared/project-root";
import loadQuickJS from "../daemon/server/skills/load-quickjs";
import type { SkillComponentBundle } from "../shared/workbench/skills/skill-component-contract";
import SkillMcpMatcherRuntime from "../shared/workbench/skills/SkillMcpMatcherRuntime";
import {
  compileSkillComponents, compileSkillMcpMatchers, compileSkillStyles, compileSkillTemplate, renderSkillComponentPreview,
  renderSkillComponentRequest,
} from "./skill-component-build.mts";

/** One skill bundle of the named components, each compiled from `<root>/<subdir><Name>.tsx`. */
async function bundleOf(root: string, names: string[], subdir = ""): Promise<SkillComponentBundle> {
  const compiled = await compileSkillComponents(names.map(name => ({ name, file: join(root, subdir, `${name}.tsx`) })), root);
  return { skillName: "test", skillPath: join(root, "SKILL.md"), revision: "0".repeat(64), components: names, code: compiled.code };
}

const renderMarkup = async (bundle: SkillComponentBundle, markup: string, results: Record<string, unknown> = {}) =>
  await renderSkillComponentRequest([bundle], { kind: "markup", markup, results });

test("skill styles include template utilities without recompiling unrelated kit utilities", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-styles-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "Card.tsx");
  const second = join(temporary.path, "Other.tsx");
  await writeFile(file, 'export default function Card() { return <div className="bg-[#123456]">card</div>; }');
  await writeFile(second, 'export default function Other() { return <div className="stuck:(text-[#654321])">other</div>; }');
  const compiled = await compileSkillStyles([file, second], temporary.path);
  assert.equal(compiled.css.includes("123456"), true);
  assert.equal(compiled.css.includes("654321"), true);
  assert.equal(compiled.css.includes("data-sticky-stuck"), true);
  assert.equal(/\.text-2xl\b/u.test(compiled.css), false, "unrelated kit utilities are not emitted");
});

test("a TSX template renders array props and content from a chat invocation", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-component-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "TrelloCard.tsx");
  await writeFile(file, `export default function Card({ labels, content }: { labels: number[], content: string }) {
    return <div>{labels.map(label => <span key={label}>{label}</span>)}{content}</div>
  }`);
  const result = await renderMarkup(await bundleOf(temporary.path, ["TrelloCard"]), '<TrelloCard labels={[1, 3, 4]} content="cool card" />');
  const output = JSON.stringify(result);
  assert.match(output, /cool card/u);
  for (const label of [1, 3, 4]) assert.match(output, new RegExp(`\\b${label}\\b`, "u"));
});

test("kit options remain native nodes inside a template fragment", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-kit-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "Choice.tsx");
  await writeFile(file, `import { Options, Option } from "workbench/kit";
    export default function Choice() {
      return <><Options label="pick"><Option title="one">first</Option><Option title="two">second</Option></Options></>
    }`);
  const output = JSON.stringify(await renderMarkup(await bundleOf(temporary.path, ["Choice"]), "<Choice />"));
  assert.match(output, /kit:Options/u);
  assert.match(output, /kit:Option/u);
  assert.match(output, /first/u);
  assert.match(output, /second/u);
});

test("the screenshot document uses the native kit renderer", async () => {
  const document = await renderSkillComponentPreview({
    css: "",
    tree: { $workbench: "element", type: "kit:Options", props: {
      label: "pick",
      children: [
        { $workbench: "element", type: "kit:Option", props: { title: "one", children: "first content" } },
        { $workbench: "element", type: "kit:Option", props: { title: "two", children: "second content" } },
      ],
    } },
  });
  assert.equal(document.includes("first content"), true);
  assert.equal(document.includes("second content"), false);
  assert.equal(document.includes("fonts.googleapis.com"), false);
});

test("preview reuses the app stylesheet and can build the standalone vis stylesheet when absent", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-preview-css-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "app.css");
  await writeFile(file, ".preview-base-marker{color:red}");
  const result = { css: "", tree: { $workbench: "element" as const, type: "div", props: {} } };
  const built = await renderSkillComponentPreview(result, file);
  assert.equal(built.includes(".preview-base-marker"), true);
  const standalone = await renderSkillComponentPreview(result, join(temporary.path, "missing.css"));
  assert.equal(standalone.includes(".text-2xl"), true);
  assert.equal(standalone.includes("fonts.googleapis.com"), false);
});

test("the component command resolves the Workbench checkout independently of its caller's cwd", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-cli-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "Card.tsx");
  const compiledFile = join(temporary.path, "compiled.json");
  await writeFile(file, "export default function Card({ text }: { text: string }) { return <p>{text}</p> }");
  await writeFile(compiledFile, JSON.stringify({
    bundles: [await bundleOf(temporary.path, ["Card"])],
    request: { kind: "markup", markup: '<Card text="@result:greeting" />', results: { greeting: "works" } },
  }));
  const result = spawnSync(process.execPath, [
    "--import", "tsx", join(projectRoot, "scripts", "skill-component-build.mts"), "render", compiledFile,
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /works/u);
});

test("kept result references anywhere in an invocation's props become the kept data", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-results-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "Lists.tsx");
  await writeFile(file, `export default function Lists({ lists }: { lists: { name: string, cards: { data: { cards: { id: string }[] } } }[] }) {
    return <div>{lists.map(list => <section key={list.name}>{list.name}:{list.cards.data.cards.map(card => card.id).join(",")}</section>)}</div>
  }`);
  const bundle = await bundleOf(temporary.path, ["Lists"]);
  const markup = '<Lists lists={[{ name: "Doing", cards: "@result:doing" }, { name: "Next", cards: "@result:next" }]} />';
  const output = JSON.stringify(await renderMarkup(bundle, markup, {
    doing: { data: { cards: [{ id: "a" }, { id: "b" }] } }, next: { data: { cards: [{ id: "c" }] } },
  }));
  assert.match(output, /Doing.*a,b/u);
  assert.match(output, /Next.*c/u);
  await assert.rejects(renderMarkup(bundle, markup, {}), /No kept MCP result named doing/u);
});

test("nested components can import helpers elsewhere inside the skill", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-import-");
  context.after(() => temporary.dispose());
  await mkdir(join(temporary.path, "components"));
  await writeFile(join(temporary.path, "label.ts"), 'export const label = "inside skill";');
  const file = join(temporary.path, "components", "Card.tsx");
  await writeFile(file, 'import { label } from "../label"; export default function Card() { return <p>{label}</p> }');
  assert.match(JSON.stringify(await renderMarkup(await bundleOf(temporary.path, ["Card"], "components"), "<Card />")), /inside skill/u);
});

test("a body's block-level invocations render inside it, and inline mentions stay text", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-nested-");
  context.after(() => temporary.dispose());
  await writeFile(join(temporary.path, "Panel.tsx"), "export default function Panel({ children }) { return <section>{children}</section> }");
  await writeFile(join(temporary.path, "Badge.tsx"), "export default function Badge({ text }) { return <b>{text}</b> }");
  const tree = await renderMarkup(await bundleOf(temporary.path, ["Panel", "Badge"]), '<Panel>\nsee `<Badge />` here\n\n<Badge text="inner" />\n</Panel>');
  const markdown = (tree.props.children as { props: { components: Record<string, unknown> } }).props;
  assert.deepEqual(Object.keys(markdown.components), ['<Badge text="inner" />']);
  assert.match(JSON.stringify(markdown.components), /inner/u);
});

test("compiled templates track the kit exports they depend on", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-kit-input-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "Card.tsx");
  await writeFile(file, 'import { Options, FlaskConicalIcon } from "workbench/kit"; export default () => <Options label="x"><FlaskConicalIcon /></Options>');
  const compiled = await compileSkillTemplate(file);
  assert.ok(compiled.inputs.includes(join(projectRoot, "app", "client", "components", "vis-kit", "index.ts")));
  assert.ok(compiled.inputs.includes(join(projectRoot, "app", "client", "components", "workbench", "workbench-icons.tsx")));
});

test("template event handlers are reported instead of silently disappearing", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-callback-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "Card.tsx");
  await writeFile(file, "export default function Card() { return <button onClick={() => 1}>click</button> }");
  await assert.rejects(renderMarkup(await bundleOf(temporary.path, ["Card"]), "<Card />"), /serializ|handler|function/i);
});

test("template execution cannot reach the host process through a constructor", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-process-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "Card.tsx");
  await writeFile(file, 'export default function Card() { const p = globalThis.constructor.constructor("return process")(); return <div>{p.platform}</div> }');
  await assert.rejects(renderMarkup(await bundleOf(temporary.path, ["Card"]), "<Card />"), /'process' is not defined/u);
});

test("a skill's matcher files bundle into one sandboxed script that presents calls through their helpers", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-matchers-");
  context.after(() => temporary.dispose());
  await writeFile(join(temporary.path, "words.ts"), 'export const builds = (ids: number[]) => ids.join(", ");');
  await writeFile(join(temporary.path, "pipelines.ts"), `import { code, defineMcpMatcher } from "workbench-skill";
    import { builds } from "./words";
    export default defineMcpMatcher(call => call.tool === "pipelines_build"
      ? { verb: ["Listing", "Listed"], summary: ["builds", code(builds(call.arguments.buildIds))] } : null);`);
  await writeFile(join(temporary.path, "fallback.ts"), `import { defineMcpMatcher } from "workbench-skill";
    export default defineMcpMatcher(() => ({ verb: ["Calling", "Called"] }));`);
  const compiled = await compileSkillMcpMatchers([join(temporary.path, "pipelines.ts"), join(temporary.path, "fallback.ts")], temporary.path);
  const runtime = new SkillMcpMatcherRuntime(await loadQuickJS(), [{
    code: compiled.code, revision: "0".repeat(64), skillName: "devops", skillPath: join(temporary.path, "SKILL.md"),
  }]);
  try {
    const call = { server: "azure-devops", tool: "pipelines_build", arguments: { buildIds: [1, 2] }, keep: null, status: "completed" as const, error: null, result: null };
    assert.deepEqual(runtime.report(call), { failures: [], match: {
      skillName: "devops", skillPath: join(temporary.path, "SKILL.md"),
      presentation: { verb: ["Listing", "Listed"], summary: ["builds", { code: "1, 2" }], display: "step" },
    } });
    assert.deepEqual(runtime.match({ ...call, tool: "other" })?.presentation.verb, ["Calling", "Called"]);
  } finally {
    runtime.dispose();
  }
  assert.ok(compiled.inputs.some(input => input.endsWith("words.ts")), "helpers are watched inputs");
});

test("matchers cannot import packages or host modules", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-matcher-imports-");
  context.after(() => temporary.dispose());
  await writeFile(join(temporary.path, "matchers.ts"), 'import { readFileSync } from "node:fs"; export default () => readFileSync;');
  await assert.rejects(compileSkillMcpMatchers([join(temporary.path, "matchers.ts")], temporary.path), /only relative files and "workbench-skill"/u);
});

test("a call component renders straight from the call props it is given", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-call-component-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "BuildList.tsx");
  await writeFile(file, "export default function BuildList({ call }: { call: { result: { id: number }[] } }) { return <ul>{call.result.map(build => <li>{build.id}</li>)}</ul> }");
  const bundle = await bundleOf(temporary.path, ["BuildList"]);
  const tree = await renderSkillComponentRequest([bundle], {
    kind: "props", skillPath: bundle.skillPath, component: "BuildList", props: { call: { result: [{ id: 23611 }] } },
  });
  assert.match(JSON.stringify(tree), /23611/u);
});

test("one skill bundle renders each of its components by name", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-inline-components-");
  context.after(() => temporary.dispose());
  await writeFile(join(temporary.path, "Label.tsx"), "export default function Label({ name }: { name: string }) { return <b>label:{name}</b> }");
  await writeFile(join(temporary.path, "Member.tsx"), "export default function Member({ name }: { name: string }) { return <i>member:{name}</i> }");
  const bundle = await bundleOf(temporary.path, ["Label", "Member"]);
  const props = (component: string, name: string) => ({ kind: "props" as const, skillPath: bundle.skillPath, component, props: { name } });
  assert.match(JSON.stringify(await renderSkillComponentRequest([bundle], props("Member", "Chiri"))), /"i".*member:.*Chiri/u);
  assert.match(JSON.stringify(await renderSkillComponentRequest([bundle], props("Label", "Bug"))), /"b".*label:.*Bug/u);
  await assert.rejects(renderSkillComponentRequest([bundle], props("Card", "x")), /exposes no component Card/u);
});
