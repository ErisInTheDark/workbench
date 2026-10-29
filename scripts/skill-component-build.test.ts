/* No production exports. Protect TSX template evaluation with the props from chat markup. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import { projectRoot } from "../shared/project-root";
import { compileSkillStyles, compileSkillTemplate, renderSkillComponent, renderSkillComponentPreview } from "./skill-component-build.mts";

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
  const compiled = await compileSkillTemplate(file);
  const result = await renderSkillComponent(compiled, "TrelloCard", '<TrelloCard labels={[1, 3, 4]} content="cool card" />');
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
  const compiled = await compileSkillTemplate(file);
  const output = JSON.stringify(await renderSkillComponent(compiled, "Choice", "<Choice />"));
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
  await writeFile(compiledFile, JSON.stringify(await compileSkillTemplate(file)));
  const result = spawnSync(process.execPath, [
    "--import", "tsx", join(projectRoot, "scripts", "skill-component-build.mts"),
    "render", compiledFile, "Card", '<Card text="works" />',
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /works/u);
});

test("nested components can import helpers elsewhere inside the skill", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-import-");
  context.after(() => temporary.dispose());
  await mkdir(join(temporary.path, "components"));
  await writeFile(join(temporary.path, "label.ts"), 'export const label = "inside skill";');
  const file = join(temporary.path, "components", "Card.tsx");
  await writeFile(file, 'import { label } from "../label"; export default function Card() { return <p>{label}</p> }');
  const compiled = await compileSkillTemplate(file, temporary.path);
  assert.match(JSON.stringify(await renderSkillComponent(compiled, "Card", "<Card />")), /inside skill/u);
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
  const compiled = await compileSkillTemplate(file);
  await assert.rejects(renderSkillComponent(compiled, "Card", "<Card />"), /serializ|handler|function/i);
});

test("template execution cannot reach the host process through a constructor", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("skill-process-");
  context.after(() => temporary.dispose());
  const file = join(temporary.path, "Card.tsx");
  await writeFile(file, 'export default function Card() { const p = globalThis.constructor.constructor("return process")(); return <div>{p.platform}</div> }');
  const compiled = await compileSkillTemplate(file);
  await assert.rejects(renderSkillComponent(compiled, "Card", "<Card />"));
});
