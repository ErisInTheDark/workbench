/* No production exports. Protect active skill resolution and immutable shown results. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchComponentsController, { type WorkbenchComponentTarget } from "./WorkbenchComponentsController";

test("a shown component keeps its result when the skill is deactivated", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("components-controller-");
  context.after(() => temporary.dispose());
  const folder = join(temporary.path, "cards");
  await mkdir(folder);
  const skillPath = join(folder, "SKILL.md");
  await writeFile(join(folder, "TrelloCard.tsx"), "export default () => null");
  const content = "---\nname: cards\nworkbench_components:\n  - TrelloCard.tsx\n---\n";
  await writeFile(skillPath, content);
  let active = true;
  const stored = new Map<string, import("workbench-shared/workbench/thread/thread-component-tree").ThreadComponentNode>();
  const key = (target: WorkbenchComponentTarget) => `${target.threadId}:${target.itemId}:${target.markup}`;
  const controller = new WorkbenchComponentsController({
    skills: async () => active ? [{ path: skillPath, relativePath: "cards/SKILL.md", name: "cards", description: "", content }] : [],
    compile: async file => ({ code: "compiled", inputs: [file] }),
    compileStyles: async files => ({ css: "", inputs: files }),
    evaluate: async () => ({ $workbench: "element", type: "div", props: { children: "original" } }),
    preview: async result => JSON.stringify(result.tree),
    read: async target => stored.get(key(target)) ?? null,
    write: async (target, tree) => {
      stored.set(key(target), tree);
      return tree;
    },
  });
  const target = { threadId: "thread", itemId: "item", markup: '<TrelloCard content="one" />' };
  const first = await controller.renderMessage(target);
  active = false;
  assert.deepEqual((await controller.renderMessage(target)).tree, first.tree);
  await assert.rejects(controller.previewMarkup("thread", target.markup), /active/i);
});

test("testing reuses a compiled template until its source changes", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("components-cache-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "Card.tsx");
  const skillPath = join(temporary.path, "SKILL.md");
  const content = "---\nworkbench_components:\n  - Card.tsx\n---\n";
  await writeFile(skillPath, content);
  await writeFile(file, "first");
  let builds = 0;
  const controller = new WorkbenchComponentsController({
    skills: async () => [{ path: skillPath, relativePath: "SKILL.md", name: "cards", description: "", content }],
    compile: async input => {
      builds += 1;
      return { code: await readFile(input, "utf8"), inputs: [input] };
    },
    compileStyles: async files => ({ css: "", inputs: files }),
    evaluate: async compiled => ({ $workbench: "element", type: "div", props: { children: compiled.code } }),
    preview: async result => JSON.stringify(result.tree),
    read: async () => null,
    write: async (_target, tree) => tree,
  });
  const target = { threadId: "thread", itemId: "item", markup: "<Card />" };
  assert.equal((await controller.renderMessage(target)).tree.props.children, "first");
  assert.match(await controller.previewMarkup("thread", "<Card />"), /first/u);
  assert.equal((await controller.renderMessage(target)).tree.props.children, "first");
  assert.equal(builds, 1);
  await writeFile(file, "second");
  assert.equal((await controller.renderMessage(target)).tree.props.children, "second");
  assert.equal(builds, 2);
});

test("a missing unrelated component does not block a valid component", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("components-missing-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "Card.tsx");
  const skillPath = join(temporary.path, "SKILL.md");
  const content = "---\nworkbench_components:\n  - Missing.tsx\n  - Card.tsx\n---\n";
  await writeFile(skillPath, content);
  await writeFile(file, "card");
  const controller = new WorkbenchComponentsController({
    skills: async () => [{ path: skillPath, relativePath: "SKILL.md", name: "cards", description: "", content }],
    compile: async input => ({ code: "card", inputs: [input] }),
    compileStyles: async files => ({ css: "", inputs: files }),
    evaluate: async () => ({ $workbench: "element", type: "div", props: { children: "valid" } }),
    read: async () => null,
    write: async (_target, result) => result,
  });
  const target = { threadId: "thread", itemId: "item", markup: "<Card />" };
  assert.equal((await controller.renderMessage(target)).tree.props.children, "valid");
  assert.equal((await controller.styles("thread")).length, 1);
  await assert.rejects(controller.renderMessage({ ...target, markup: "<Missing />" }));
});

test("a template whose body names its own invocation fails instead of recursing forever", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("components-recursion-");
  context.after(() => temporary.dispose());
  const skillPath = join(temporary.path, "SKILL.md");
  const content = "---\nworkbench_components:\n  - Loop.tsx\n---\n";
  await writeFile(skillPath, content);
  await writeFile(join(temporary.path, "Loop.tsx"), "loop");
  let evaluations = 0;
  const controller = new WorkbenchComponentsController({
    skills: async () => [{ path: skillPath, relativePath: "SKILL.md", name: "loop", description: "", content }],
    compile: async file => ({ code: "loop", inputs: [file] }),
    compileStyles: async files => ({ css: "", inputs: files }),
    evaluate: async () => {
      evaluations += 1;
      return { $workbench: "element", type: "workbench:markdown", props: { source: "<Loop />", components: { "<Loop />": null } } };
    },
    read: async () => null,
    write: async (_target, tree) => tree,
  });
  await assert.rejects(controller.renderMessage({ threadId: "thread", itemId: "item", markup: "<Loop />" }), /nest deeper/u);
  assert.ok(evaluations < 20);
});

test("referenced kept results reach the template, and the saved tree carries its images inline", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("components-results-");
  context.after(() => temporary.dispose());
  const skillPath = join(temporary.path, "SKILL.md");
  const content = "---\nworkbench_components:\n  - Cards.tsx\n---\n";
  await writeFile(skillPath, content);
  await writeFile(join(temporary.path, "Cards.tsx"), "cards");
  const asked: string[][] = [];
  const saved: unknown[] = [];
  const controller = new WorkbenchComponentsController({
    skills: async () => [{ path: skillPath, relativePath: "SKILL.md", name: "cards", description: "", content }],
    compile: async file => ({ code: "cards", inputs: [file] }),
    compileStyles: async files => ({ css: "", inputs: files }),
    evaluate: async (_compiled, _name, _markup, results) => ({ $workbench: "element", type: "img", props: {
      alt: JSON.stringify(results), src: "https://img.example.test/a.png",
    } }),
    results: async (_threadId, names) => { asked.push([...names]); return names.includes("doing") ? { doing: { cards: 2 } } : {}; },
    fetchImage: async () => ({ contentType: "image/png", bytes: Buffer.from("png") }),
    read: async () => null,
    write: async (_target, tree) => { saved.push(tree); return tree; },
  });
  const rendered = await controller.renderMessage({ threadId: "thread", itemId: "item", markup: '<Cards lists={[{ cards: "@result:doing" }]} />' });
  assert.deepEqual(asked, [["doing"]]);
  assert.equal(rendered.tree.props.alt, JSON.stringify({ doing: { cards: 2 } }));
  assert.equal(rendered.tree.props.src, `data:image/png;base64,${Buffer.from("png").toString("base64")}`);
  assert.equal(JSON.stringify(saved).includes("https://"), false);
  await assert.rejects(controller.renderMessage({ threadId: "thread", itemId: "other", markup: '<Cards lists="@result:gone" />' }),
    /No kept MCP result named gone in this thread/u);
});

test("one active skill shares its stylesheet across simultaneous requests and drops it on deactivation", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-styles-owner-");
  context.after(() => temporary.dispose());
  const skillPath = join(temporary.path, "SKILL.md");
  const first = join(temporary.path, "First.tsx");
  const second = join(temporary.path, "Second.tsx");
  const content = "---\nworkbench_components:\n  - First.tsx\n  - Second.tsx\n---\n";
  await writeFile(skillPath, content);
  await writeFile(first, "first");
  await writeFile(second, "second");
  let active = true;
  let builds = 0;
  const controller = new WorkbenchComponentsController({
    skills: async () => active ? [{ path: skillPath, relativePath: "SKILL.md", name: "cards", description: "", content }] : [],
    compile: async file => ({ code: "compiled", inputs: [file] }),
    compileStyles: async files => { builds += 1; return { css: (await Promise.all(files.map(file => readFile(file, "utf8")))).join(" "), inputs: files }; },
    evaluate: async () => ({ $workbench: "element", type: "div", props: {} }),
    read: async () => null,
    write: async (_target, result) => result,
  });
  const [one, two] = await Promise.all([controller.styles("thread"), controller.styles("thread")]);
  assert.equal(builds, 1);
  assert.deepEqual(one, two);
  assert.match(one[0]!.css, /first second/u);
  await writeFile(second, "changed");
  assert.match((await controller.styles("thread"))[0]!.css, /first changed/u);
  assert.equal(builds, 2);
  active = false;
  assert.deepEqual(await controller.styles("thread"), []);
});

/** Two skills: `devops` with a matcher and a call component, and `broken` whose matcher fails to compile. */
async function callSkills(path: string) {
  const skill = async (name: string, content: string, files: Record<string, string>) => {
    await mkdir(join(path, name));
    for (const [file, source] of Object.entries(files)) await writeFile(join(path, name, file), source);
    await writeFile(join(path, name, "SKILL.md"), content);
    return { path: join(path, name, "SKILL.md"), relativePath: `${name}/SKILL.md`, name, description: "", content };
  };
  return [
    await skill("broken", "---\nworkbench_mcp_matchers: [matchers.ts]\n---\n", { "matchers.ts": "broken" }),
    await skill("devops", "---\nworkbench_components: [BuildList.tsx]\nworkbench_mcp_matchers: [matchers.ts]\n---\n", {
      "BuildList.tsx": "export default () => null", "matchers.ts": "fine",
    }),
  ];
}

test("a call component renders only from its active skill, once, with the result its call kept", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("call-components-");
  context.after(() => temporary.dispose());
  const skills = await callSkills(temporary.path);
  let active = skills;
  const stored = new Map<string, import("workbench-shared/workbench/thread/thread-component-tree").ThreadComponentNode>();
  const rendered: unknown[] = [];
  const runs: string[][] = [];
  const controller = new WorkbenchComponentsController({
    skills: async () => active,
    compile: async file => ({ code: "compiled", inputs: [file] }),
    compileStyles: async files => ({ css: "", inputs: files }),
    evaluate: async () => { throw new Error("Message components are not rendered here."); },
    results: async (_threadId, names) => names.includes("b23611b") ? { b23611b: { builds: [{ id: 23611 }] } } : {},
    read: async () => null,
    write: async (_target, tree) => tree,
    calls: {
      compileMatchers: async files => {
        if ((await readFile(files[0]!, "utf8")) === "broken") throw new Error("Unexpected token");
        return { code: "var __wbSkillMcpMatchers = { default: [] };", inputs: [...files] };
      },
      renderProps: async (_compiled, renders) => {
        runs.push(renders.map(({ component }) => component));
        return renders.map(({ props }) => {
          rendered.push(props);
          return { $workbench: "element" as const, type: "div", props: { children: JSON.stringify(props) } };
        });
      },
      quickjs: async () => { throw new Error("Not needed."); },
      read: async target => stored.get(`${target.itemId}:${target.component}:${target.slot ?? ""}`) ?? null,
      write: async (target, tree) => { stored.set(`${target.itemId}:${target.component}:${target.slot ?? ""}`, tree); return tree; },
    },
  });

  const compiled = await controller.matchers("thread");
  assert.deepEqual(compiled.bundles.map(bundle => bundle.skillName), ["devops"]);
  assert.deepEqual(compiled.failures.map(failure => [failure.skillName, failure.message]), [["broken", "Unexpected token"]]);

  const target = { threadId: "thread", itemId: "call", skillPath: skills[1]!.path, component: "BuildList" };
  const call = { server: "azure-devops", tool: "pipelines_build", arguments: {}, keep: "b23611b", status: "completed", error: null, result: "Saved to b23611b." };
  const first = await controller.renderCall({ ...target, props: { call } });
  assert.deepEqual(rendered, [{ call: { ...call, result: { builds: [{ id: 23611 }] } } }]);
  assert.deepEqual((await controller.renderCall({ ...target, props: { call: { ...call, result: null } } })).tree, first.tree);
  assert.equal(rendered.length, 1);

  // A line's inline components: kept per props, and only the missing ones render, together in one run.
  const line = { threadId: "thread", itemId: "call", skillPath: skills[1]!.path };
  const bug = { component: "BuildList", props: { name: "Bug" } };
  const internal = { component: "BuildList", props: { name: "Internal" } };
  const firstLine = await controller.renderInline({ ...line, parts: [bug] });
  const secondLine = await controller.renderInline({ ...line, parts: [internal, bug] });
  assert.deepEqual(secondLine[1]!.tree, firstLine[0]!.tree);
  assert.deepEqual(runs.slice(1), [["BuildList"], ["BuildList"]]);
  assert.deepEqual(rendered.slice(1), [{ name: "Bug" }, { name: "Internal" }]);
  assert.deepEqual((await controller.renderCall({ ...target, props: { call } })).tree, first.tree, "the call's own component keeps its slot");

  active = [skills[0]!];
  await assert.rejects(controller.renderCall({ ...target, itemId: "later", props: { call } }), /not active in this thread/u);
});
