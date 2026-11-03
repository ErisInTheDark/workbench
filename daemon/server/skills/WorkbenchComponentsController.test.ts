/* No production exports. Protect skill extension builds, kept snapshots and previews. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import type { ThreadComponentNode } from "workbench-shared/workbench/thread/thread-component-tree";
import type { SkillComponentTarget } from "workbench-shared/workbench/skills/skill-component-contract";
import WorkbenchComponentsController, { type WorkbenchComponentRenderInput, type WorkbenchComponentsOptions } from "./WorkbenchComponentsController";

const unused = async () => { throw new Error("Not used here."); };

function controller(options: Partial<WorkbenchComponentsOptions> & Pick<WorkbenchComponentsOptions, "skills">) {
  return new WorkbenchComponentsController({
    compileComponents: async components => ({ code: components.map(({ name }) => name).join(","), inputs: components.map(({ file }) => file) }),
    compileStyles: async files => ({ css: "", inputs: files }),
    compileMatchers: async files => ({ code: "var __wbSkillMcpMatchers = { default: [] };", inputs: [...files] }),
    readKept: unused,
    writeKept: unused,
    ...options,
  });
}

async function skill(root: string, name: string, frontmatter: string, files: Record<string, string>) {
  await mkdir(join(root, name));
  for (const [file, source] of Object.entries(files)) await writeFile(join(root, name, file), source);
  const content = `---\nname: ${name}\n${frontmatter}\n---\n`;
  await writeFile(join(root, name, "SKILL.md"), content);
  return { path: join(root, name, "SKILL.md"), relativePath: `${name}/SKILL.md`, name, description: "", content };
}

test("a skill's components compile into one bundle, reused until a source changes", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("components-bundle-");
  context.after(() => temporary.dispose());
  const cards = await skill(temporary.path, "cards", "workbench_components: [Card.tsx, Missing.tsx, List.tsx]", { "Card.tsx": "first", "List.tsx": "list" });
  const runs: string[][] = [];
  const components = controller({
    skills: async () => [cards],
    compileComponents: async (declared) => {
      runs.push(declared.map(({ name }) => name));
      const code = (await Promise.all(declared.map(({ file }) => readFile(file, "utf8")))).join(",");
      return { code, inputs: declared.map(({ file }) => file) };
    },
  });
  const first = (await components.extensions("thread")).components;
  assert.deepEqual(first.map(bundle => bundle.components), [["Card", "List"]], "a missing file leaves out only itself");
  assert.equal((await components.extensions("thread")).components[0]!.revision, first[0]!.revision);
  assert.deepEqual(runs, [["Card", "List"]]);
  await writeFile(join(temporary.path, "cards", "Card.tsx"), "second");
  const changed = (await components.extensions("thread")).components[0]!;
  assert.notEqual(changed.revision, first[0]!.revision);
  assert.equal(runs.length, 2);
});

test("one skill's failing part is reported without hiding its other parts or other skills", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("components-extensions-");
  context.after(() => temporary.dispose());
  const broken = await skill(temporary.path, "broken", "workbench_mcp_matchers: [matchers.ts]\nworkbench_components: [Card.tsx]", {
    "matchers.ts": "broken", "Card.tsx": "card",
  });
  const devops = await skill(temporary.path, "devops", "workbench_mcp_matchers: [matchers.ts]", { "matchers.ts": "fine" });
  let reads = 0;
  const extensions = await controller({
    skills: async () => { reads += 1; return [broken, devops]; },
    compileMatchers: async files => {
      if ((await readFile(files[0]!, "utf8")) === "broken") throw new Error("Unexpected token");
      return { code: "var __wbSkillMcpMatchers = { default: [] };", inputs: [...files] };
    },
  }).extensions("thread");
  assert.equal(reads, 1);
  assert.deepEqual(extensions.matchers.map(bundle => bundle.skillName), ["devops"]);
  assert.deepEqual(extensions.components.map(bundle => bundle.skillName), ["broken"]);
  assert.deepEqual(extensions.styles.map(style => style.path), [broken.path]);
  assert.deepEqual(extensions.failures.map(failure => [failure.skillName, failure.kind, failure.message]), [["broken", "matchers", "Unexpected token"]]);
});

test("simultaneous extension reads share one stylesheet build", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("components-styles-");
  context.after(() => temporary.dispose());
  const cards = await skill(temporary.path, "cards", "workbench_components: [First.tsx, Second.tsx]", { "First.tsx": "first", "Second.tsx": "second" });
  let builds = 0;
  const components = controller({
    skills: async () => [cards],
    compileStyles: async files => { builds += 1; return { css: (await Promise.all(files.map(file => readFile(file, "utf8")))).join(" "), inputs: files }; },
  });
  const [one, two] = await Promise.all([components.extensions("thread"), components.extensions("thread")]);
  assert.equal(builds, 1);
  assert.deepEqual(one.styles, two.styles);
  assert.match(one.styles[0]!.css, /first second/u);
});

test("a kept snapshot is validated and carries its images inline", async () => {
  const kept: [SkillComponentTarget, ThreadComponentNode][] = [];
  const components = controller({
    skills: async () => [],
    fetchImage: async () => ({ contentType: "image/png", bytes: Buffer.from("png") }),
    writeKept: async (_threadId, target, tree) => { kept.push([target, tree]); return tree; },
  });
  const target: SkillComponentTarget = { kind: "call", itemId: "call", skillPath: "/skills/devops/SKILL.md", component: "BuildList" };
  await components.keep("thread", target, { $workbench: "element", type: "img", props: { src: "https://img.example.test/a.png" } });
  assert.deepEqual(kept, [[target, { $workbench: "element", type: "img", props: { src: `data:image/png;base64,${Buffer.from("png").toString("base64")}` } }]]);
  await assert.rejects(components.keep("thread", target, { $workbench: "element", type: "script", props: {} }), /Unsupported component element/u);
  assert.equal(kept.length, 1);
});

test("previews render active skills' bundles with the kept results their markup names", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("components-preview-");
  context.after(() => temporary.dispose());
  const cards = await skill(temporary.path, "cards", "workbench_components: [Cards.tsx]", { "Cards.tsx": "cards" });
  const rendered: WorkbenchComponentRenderInput[] = [];
  const asked: string[][] = [];
  const preview = await controller({
    skills: async () => [cards],
    results: async (_threadId, names) => { asked.push([...names]); return { doing: { cards: 2 } }; },
    render: async input => { rendered.push(input); return { $workbench: "element", type: "div", props: {} }; },
    preview: async result => JSON.stringify(result.tree),
  }).previewMarkup("thread", '<Cards lists={[{ cards: "@result:doing" }]} />');
  assert.equal(preview, JSON.stringify({ $workbench: "element", type: "div", props: {} }));
  assert.deepEqual(asked, [["doing"]]);
  assert.deepEqual(rendered.map(({ bundles, request }) => [bundles.map(bundle => bundle.components), request]), [[
    [["Cards"]], { kind: "markup", markup: '<Cards lists={[{ cards: "@result:doing" }]} />', results: { doing: { cards: 2 } } },
  ]]);
});
