/*
 * Exports:
 * - CompiledSkillComponent: compiled template code and dependencies.
 * - compileSkillTemplate: compile TSX and identify its input files.
 * - compileSkillComponents: compile one skill's components into one bundle script that registers each by name.
 * - compileSkillStyles: compile only the utilities used by one skill's templates.
 * - compileSkillMcpMatchers: bundle one skill's MCP matcher files into one sandbox-ready script and identify its input files.
 * - renderSkillComponentRequest: render one request from bundles in the sandboxed runtime the browser uses, for previews.
 * - renderSkillComponentPreview: render native component nodes as a screenshot document.
 */
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as Esbuild from "../app/node_modules/esbuild/lib/main";
import { projectRoot } from "../shared/project-root.ts";
import {
  ThreadComponentStyleBuildSchema, readThreadComponentPreview,
  type ThreadComponentNode, type ThreadCompiledComponent, type ThreadCompiledStyle, type ThreadComponentPreview,
} from "../shared/workbench/thread/thread-component-tree.ts";
import { conformToZodSchema } from "../shared/workbench/zod-schema-conformer.ts";
import { expandVariantGroupsInSource } from "../app/server/variant-group-source.ts";
import { collectTailwindCandidates } from "./tailwind-candidates.mts";
import {
  SkillComponentBuildSchema, SkillComponentRenderInputSchema, type SkillComponentBundle, type SkillComponentRequest,
} from "../shared/workbench/skills/skill-component-contract.ts";
import SkillComponentRuntime from "../shared/workbench/skills/SkillComponentRuntime.ts";
import { WORKBENCH_SKILL_MODULE_SOURCE } from "../shared/workbench/skills/workbench-skill-module.ts";
import { listMarkdownComponentInvocations } from "../app/client/workbench/markdown/markdown-component-invocations.ts";

const scriptPath = /^skill-component-build\.(?:mts|ts)$/u.test(path.basename(process.argv[1] ?? ""))
  ? path.resolve(process.argv[1]!) : null;
const root = scriptPath ? path.dirname(path.dirname(scriptPath)) : projectRoot;
const app = path.join(root, "app");
const requireFromApp = createRequire(path.join(app, "package.json"));
const esbuild: typeof Esbuild = requireFromApp("esbuild");
const tailwindCli = path.join(path.dirname(requireFromApp.resolve("@tailwindcss/cli/package.json")), "dist", "index.mjs");

export type CompiledSkillComponent = ThreadCompiledComponent;

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

/**
 * Bundle one skill's matcher files into a script that assigns their default exports, in order, to the global the
 * sandboxed runtime reads. Imports stay inside the skill; the only bare import is `workbench-skill`.
 */
export async function compileSkillMcpMatchers(files: readonly string[], rootPath: string): Promise<CompiledSkillComponent> {
  const skillRoot = await realpath(rootPath);
  const entries = await Promise.all(files.map(file => realpath(file)));
  const plugin: Esbuild.Plugin = {
    name: "workbench-skill-mcp-matchers",
    setup(build) {
      build.onResolve({ filter: /^workbench-skill-mcp-entry$/ }, () => ({ path: "entry", namespace: "matcher" }));
      build.onResolve({ filter: /^workbench-skill$/ }, () => ({ path: "kit", namespace: "matcher" }));
      build.onResolve({ filter: /^[^./]/ }, args => args.namespace === "matcher" && path.isAbsolute(args.path) ? undefined : {
        errors: [{ text: `Matchers run sandboxed and can import only relative files and "workbench-skill": ${args.path}` }],
      });
      build.onLoad({ filter: /.*/, namespace: "matcher" }, args => args.path === "kit"
        ? { contents: WORKBENCH_SKILL_MODULE_SOURCE, loader: "js" }
        : {
          contents: [
            ...entries.map((file, index) => `import matcher${index} from ${JSON.stringify(file)};`),
            `export default [${entries.map((_file, index) => `matcher${index}`).join(", ")}];`,
          ].join("\n"),
          loader: "js",
          resolveDir: skillRoot,
        });
    },
  };
  const built = await esbuild.build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: ["workbench-skill-mcp-entry"],
    format: "iife",
    globalName: "__wbSkillMcpMatchers",
    logLevel: "silent",
    metafile: true,
    platform: "neutral",
    plugins: [plugin],
    target: "es2022",
    write: false,
  });
  const inputs: string[] = [];
  for (const input of Object.keys(built.metafile.inputs)) {
    if (input.startsWith("matcher:")) continue;
    const resolved = await realpath(path.resolve(root, input));
    const relative = path.relative(skillRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`MCP matcher import escapes its skill: ${input}`);
    }
    inputs.push(resolved);
  }
  return { code: built.outputFiles[0]!.text, inputs: [...new Set([...inputs, ...entries])] };
}

/**
 * One skill's components as one script for the sandboxed runtime: each compiled template runs in its own module scope
 * and registers its default export by name on `__wbSkillComponents`.
 */
export async function compileSkillComponents(
  components: readonly { name: string; file: string }[], rootPath: string,
): Promise<CompiledSkillComponent> {
  const compiled = await Promise.all(components.map(async ({ name, file }) => ({ name, compiled: await compileSkillTemplate(file, rootPath) })));
  const code = [
    "globalThis.__wbSkillComponents = {};",
    ...compiled.map(({ name, compiled: template }) => `(function () {
  var module = { exports: {} };
  (function (module, exports) { ${template.code}\n })(module, module.exports);
  globalThis.__wbSkillComponents[${JSON.stringify(name)}] = module.exports.default;
})();`),
  ].join("\n");
  return { code, inputs: [...new Set(compiled.flatMap(({ compiled: template }) => template.inputs))] };
}

type QuickJSWASMModule = ConstructorParameters<typeof SkillComponentRuntime>[0];
let quickjs: Promise<QuickJSWASMModule> | null = null;
function loadQuickJS() {
  quickjs ??= (async () => {
    const core: { newQuickJSWASMModuleFromVariant(variant: unknown): Promise<QuickJSWASMModule> } = requireFromApp("quickjs-emscripten-core");
    return await core.newQuickJSWASMModuleFromVariant(requireFromApp("@jitl/quickjs-wasmfile-release-sync"));
  })();
  return quickjs;
}

/** One request rendered exactly as the browser renders it, in a runtime that lives only for the call. */
export async function renderSkillComponentRequest(
  bundles: readonly SkillComponentBundle[], request: SkillComponentRequest,
): Promise<ThreadComponentNode> {
  const runtime = new SkillComponentRuntime(await loadQuickJS(), bundles, { nestedInvocations: listMarkdownComponentInvocations });
  try { return runtime.render(request); }
  finally { runtime.dispose(); }
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
  const [action, file] = process.argv.slice(2);
  if (action === "components" && file) {
    const parsed = SkillComponentBuildSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) throw new Error("Invalid component build.");
    process.stdout.write(JSON.stringify(await compileSkillComponents(parsed.data.components, parsed.data.root)));
  } else if (action === "styles" && file) {
    const parsed = conformToZodSchema(ThreadComponentStyleBuildSchema, JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success || parsed.discardedPaths.length || parsed.repairedPaths.length) throw new Error("Invalid component style build.");
    process.stdout.write(JSON.stringify(await compileSkillStyles(parsed.data.files, parsed.data.root)));
  } else if (action === "render" && file) {
    const parsed = SkillComponentRenderInputSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) throw new Error("Component render input is invalid.");
    process.stdout.write(JSON.stringify(await renderSkillComponentRequest(parsed.data.bundles, parsed.data.request)));
  } else if (action === "matchers" && file) {
    const parsed = ThreadComponentStyleBuildSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) throw new Error("Invalid MCP matcher build.");
    process.stdout.write(JSON.stringify(await compileSkillMcpMatchers(parsed.data.files, parsed.data.root)));
  } else if (action === "preview" && file) {
    const result = readThreadComponentPreview(JSON.parse(await readFile(file, "utf8")));
    process.stdout.write(JSON.stringify(await renderSkillComponentPreview(result)));
  } else {
    throw new Error("Usage: skill-component-build.mts components <input> | styles <input> | render <input> | matchers <input> | preview <result>");
  }
}

if (scriptPath) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
