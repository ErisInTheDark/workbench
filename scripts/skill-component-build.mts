/*
 * Exports:
 * - CompiledSkillComponent: compiled template code and dependencies.
 * - compileSkillTemplate: compile TSX and identify its input files.
 * - compileSkillStyles: compile only the utilities used by one skill's templates.
 * - renderSkillComponent: render an invocation into native component nodes; its body lists nested invocations to resolve.
 * - renderSkillComponentPreview: render native component nodes as a screenshot document.
 */
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";
import type * as Esbuild from "../app/node_modules/esbuild/lib/main";
import { projectRoot } from "../shared/project-root.ts";
import {
  readThreadComponentTree, ThreadCompiledComponentSchema, ThreadComponentStyleBuildSchema, readThreadComponentPreview,
  type ThreadComponentNode, type ThreadCompiledComponent, type ThreadCompiledStyle, type ThreadComponentPreview,
} from "../shared/workbench/thread/thread-component-tree.ts";
import { conformToZodSchema } from "../shared/workbench/zod-schema-conformer.ts";
import { expandVariantGroupsInSource } from "../app/server/variant-group-source.ts";
import { collectTailwindCandidates } from "./tailwind-candidates.mts";
import { readThreadComponentMarkup } from "../shared/workbench/thread/thread-component-markup.ts";
import { parseBlocks, type ParsedBlock } from "../app/client/workbench/markdown/markdown-parse.ts";

const scriptPath = /^skill-component-build\.(?:mts|ts)$/u.test(path.basename(process.argv[1] ?? ""))
  ? path.resolve(process.argv[1]!) : null;
const root = scriptPath ? path.dirname(path.dirname(scriptPath)) : projectRoot;
const app = path.join(root, "app");
const requireFromApp = createRequire(path.join(app, "package.json"));
const esbuild: typeof Esbuild = requireFromApp("esbuild");
const tailwindCli = path.join(path.dirname(requireFromApp.resolve("@tailwindcss/cli/package.json")), "dist", "index.mjs");
const COMPONENT_EXECUTION_TIMEOUT_MS = 5_000;

export type CompiledSkillComponent = ThreadCompiledComponent;

/** A body's markdown node lists its nested invocations, found by the thread parser, for the daemon to resolve. */
function childMarkdown(source: string): ThreadComponentNode {
  const components: Record<string, null> = {};
  const walk = (blocks: ParsedBlock[]) => {
    for (const block of blocks) {
      if (block.type === "component") components[block.text] = null;
      else if (block.type === "notice" || block.type === "details" || block.type === "plan") {
        walk(parseBlocks(block.text, { profile: "thread" }));
      } else if (block.type === "ul" || block.type === "ol") {
        for (const item of block.items) walk(item.children);
      }
    }
  };
  walk(parseBlocks(source, { profile: "thread" }));
  return { $workbench: "element", type: "workbench:markdown", props: { source, components } };
}

export async function compileSkillTemplate(file: string, rootPath = path.dirname(file)): Promise<CompiledSkillComponent> {
  const entry = await realpath(file);
  const skillRoot = await realpath(rootPath);
  const kitIndex = path.join(app, "client", "components", "vis-kit", "index.ts");
  const kitSource = await readFile(kitIndex, "utf8");
  const starImports = [...kitSource.matchAll(/^export\s+\*\s+from\s+["']([^"']+)["']/gmu)].map(match => match[1]!);
  const entries = [kitIndex];
  for (const relative of starImports) {
    const stem = path.resolve(path.dirname(kitIndex), relative);
    let resolved: string | null = null;
    for (const extension of [".ts", ".tsx"]) {
      try { resolved = await realpath(`${stem}${extension}`); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!resolved) throw new Error(`Cannot resolve kit export: ${relative}`);
    entries.push(resolved);
  }
  const kitMetadata = await esbuild.build({
    entryPoints: entries, outdir: root, bundle: false, format: "esm", write: false, metafile: true, logLevel: "silent",
  });
  const kitNames = [...new Set(Object.values(kitMetadata.metafile.outputs).flatMap(output => output.exports))]
    .filter(name => /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name));
  const runtime = `
    export const Fragment = "fragment";
    export function jsx(type, props, key) {
      const value = key === undefined ? (props ?? {}) : { ...props, key };
      return typeof type === "function" ? type(value) : { $workbench: "element", type, props: value };
    }
    export const jsxs = jsx;
    export const jsxDEV = jsx;
    export function createElement(type, props, ...children) {
      return jsx(type, { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) });
    }
    export default { createElement, Fragment };
  `;
  const plugin: Esbuild.Plugin = {
    name: "workbench-component-template",
    setup(build) {
      build.onResolve({ filter: /^workbench\/kit$/ }, () => ({ path: "kit", namespace: "component" }));
      build.onResolve({ filter: /^workbench-template\/jsx-(?:dev-)?runtime$/ }, () => ({ path: "runtime", namespace: "component" }));
      build.onResolve({ filter: /^react(?:\/jsx-(?:dev-)?runtime)?$/ }, () => ({ path: "runtime", namespace: "component" }));
      build.onLoad({ filter: /.*/, namespace: "component" }, args => ({
        contents: args.path === "kit"
          ? kitNames.map(name => name.startsWith("use")
            ? `export function ${name}() { throw new Error("Template hooks cannot run in chat."); }`
            : `export const ${name} = ${JSON.stringify(`kit:${name}`)};`).join("\n")
          : runtime,
        loader: "js",
      }));
      build.onLoad({ filter: /\.[jt]sx?$/ }, async args => {
        if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
        const source = await readFile(args.path, "utf8");
        const expanded = expandVariantGroupsInSource(source, args.path);
        const extension = path.extname(args.path);
        const loader = extension === ".tsx" ? "tsx" : extension === ".ts" ? "ts" : extension === ".jsx" ? "jsx" : "js";
        return expanded.map ? { contents: expanded.code, loader, resolveDir: path.dirname(args.path) } : undefined;
      });
    },
  };
  const built = await esbuild.build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: [entry],
    format: "cjs",
    jsx: "automatic",
    jsxImportSource: "workbench-template",
    logLevel: "silent",
    metafile: true,
    platform: "node",
    plugins: [plugin],
    write: false,
  });
  const inputs: string[] = [];
  for (const input of Object.keys(built.metafile.inputs)) {
    if (input.startsWith("component:")) continue;
    const resolved = await realpath(path.resolve(root, input));
    const relative = path.relative(skillRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Component import escapes its skill: ${input}`);
    }
    inputs.push(resolved);
  }
  return { code: built.outputFiles[0]!.text, inputs: [...new Set([...inputs, ...entries])] };
}

async function stylesheetInputs(file: string, seen = new Set<string>()): Promise<string[]> {
  const resolved = await realpath(file);
  if (seen.has(resolved)) return [];
  seen.add(resolved);
  const source = await readFile(resolved, "utf8");
  const imports = [...source.matchAll(/@import\s+["'](\.[^"']+)["']/gu)].map(match => match[1]!);
  return [resolved, ...(await Promise.all(imports.map(value =>
    stylesheetInputs(path.resolve(path.dirname(resolved), value), seen)))).flat()];
}

async function compileTailwind(cssInput: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [tailwindCli, "--input", "-", "--minify"], {
      cwd: path.join(app, "client"), stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(output) : reject(new Error(`Tailwind exited with code ${code}: ${error.slice(0, 2_000)}`)));
    child.stdin.end(cssInput);
  });
}

export async function compileSkillStyles(files: readonly string[], skillRoot: string): Promise<ThreadCompiledStyle> {
  const templates = await Promise.all(files.map(file => compileSkillTemplate(file, skillRoot)));
  const stylesheet = path.join(app, "client", "tailwind.css");
  const cssInput = [
    `@reference ${JSON.stringify(stylesheet.replaceAll("\\", "/"))};`,
    '@import "tailwindcss/utilities.css" layer(utilities) source(none);',
    '@source not "./";',
    `@source inline(${JSON.stringify(templates.flatMap(template => collectTailwindCandidates(template.code)).join(" "))});`,
  ].join("\n");
  const css = await compileTailwind(cssInput);
  return {
    css, inputs: [...new Set([...templates.flatMap(template => template.inputs), ...await stylesheetInputs(stylesheet)])],
  };
}

export async function renderSkillComponent(compiled: CompiledSkillComponent, name: string, markup: string): Promise<ThreadComponentNode> {
  if (!/^[A-Z][A-Za-z0-9_]*$/u.test(name)) throw new Error("Invalid component name.");
  const parsed = readThreadComponentMarkup(markup);
  if (!parsed || parsed.end !== markup.length || parsed.name !== name) throw new Error("Expected one complete component invocation.");
  const opening = parsed.body === null ? parsed.opening : parsed.opening.replace(/>\s*$/u, " />");
  const invocation = await esbuild.transform(`module.exports = (${opening});`, {
    loader: "tsx", format: "cjs", jsx: "transform", jsxFactory: "__wbCreateElement", logLevel: "silent",
  });
  const program = `
    const __wbTemplate = { exports: {} };
    (function(module, exports) { ${compiled.code}\n })(__wbTemplate, __wbTemplate.exports);
    const __wbDefault = __wbTemplate.exports.default;
    if (typeof __wbDefault !== "function") throw new Error("Component must have a default function export.");
    const __wbResult = { exports: {} };
    const __wbChildren = ${JSON.stringify(parsed.body === null ? null : childMarkdown(parsed.body.trim()))};
    const __wbCreateElement = (type, props, ...children) => {
      if (type === __wbDefault && __wbChildren !== null) children = [__wbChildren];
      const value = { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) };
      return typeof type === "function" ? type(value) : { $workbench: "element", type, props: value };
    };
    (function(module, exports, __wbCreateElement, ${name}) { ${invocation.code}\n })
      (__wbResult, __wbResult.exports, __wbCreateElement, __wbDefault);
    JSON.stringify(__wbResult.exports, (_key, value) => {
      if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
        throw new Error("Component output contains a non-serializable function or value.");
      }
      return value;
    });
  `;
  const serialized: unknown = new Script(program, { filename: "component-markup.cjs" }).runInNewContext(Object.create(null), {
    timeout: COMPONENT_EXECUTION_TIMEOUT_MS, contextCodeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate",
  });
  if (typeof serialized !== "string") throw new Error("Component output must be a serializable element tree.");
  return readThreadComponentTree(JSON.parse(serialized));
}

export async function renderSkillComponentPreview(
  result: ThreadComponentPreview, appCssPath = path.join(root, ".workbench", "app", "frontend", "assets", "app.css"),
): Promise<string> {
  const { renderThreadComponentNode } = await import(pathToFileURL(
    path.join(app, "client", "components", "workbench", "thread-view", "thread-component-render.tsx"),
  ).href);
  const server: { renderToStaticMarkup(node: ReturnType<typeof renderThreadComponentNode>): string } = requireFromApp("react-dom/server");
  const safe = readThreadComponentPreview(result);
  const html = server.renderToStaticMarkup(renderThreadComponentNode(safe.tree));
  let base: string;
  try {
    base = await readFile(appCssPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const visPage = path.join(app, "client", "components", "vis-kit", "vis-page.css");
    base = await compileTailwind(`@import ${JSON.stringify(visPage.replaceAll("\\", "/"))};`);
  }
  const css = `${base.replace(/@import\s+(?:url\([^)]*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;/giu, "")}\n${safe.css}\nbody::before{content:none}`.replace(/<\/style/giu, "<\\/style");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>`
    + `<body class="text-text">${html}</body></html>`;
}

async function main() {
  const [action, file, name, markup] = process.argv.slice(2);
  if (action === "compile" && file) process.stdout.write(JSON.stringify(await compileSkillTemplate(file, name)));
  else if (action === "styles" && file) {
    const parsed = conformToZodSchema(ThreadComponentStyleBuildSchema, JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success || parsed.discardedPaths.length || parsed.repairedPaths.length) throw new Error("Invalid component style build.");
    process.stdout.write(JSON.stringify(await compileSkillStyles(parsed.data.files, parsed.data.root)));
  }
  else if (action === "render" && file && name && markup) {
    const parsed = conformToZodSchema(ThreadCompiledComponentSchema, JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success || parsed.discardedPaths.length || parsed.repairedPaths.length) {
      throw new Error("Compiled component is invalid.");
    }
    process.stdout.write(JSON.stringify(await renderSkillComponent(parsed.data, name, markup)));
  } else if (action === "preview" && file) {
    const result = readThreadComponentPreview(JSON.parse(await readFile(file, "utf8")));
    process.stdout.write(JSON.stringify(await renderSkillComponentPreview(result)));
  } else throw new Error("Usage: skill-component-build.mts compile <file> | styles <input> | render <compiled> <name> <markup> | preview <result>");
}

if (scriptPath) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
