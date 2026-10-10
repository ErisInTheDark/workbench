/*
 * No exports. Builds one .tsx/.jsx vis file for this repository: bundles its default export with React in memory,
 * expands Tailwind variant groups like the app build, compiles the app's Tailwind for it, and prints
 * `{ document, inputs }` to stdout. Writes no files, so it runs in a read-only sandbox.
 * With `--kit` (Workbench's default vis context) the file may live in any project: it imports `workbench/vis`,
 * React and its own relative files, always against Workbench's copies, never repository paths.
 * Usage: node --import tsx scripts/vis-build.mts [--kit] <file>
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandVariantGroupsInSource } from "../app/server/variant-group-source.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "app");
const requireFromApp = createRequire(path.join(app, "package.json"));
const esbuild: typeof import("esbuild") = requireFromApp("esbuild");
const tailwindCli = path.join(path.dirname(requireFromApp.resolve("@tailwindcss/cli/package.json")), "dist", "index.mjs");

const args = process.argv.slice(2);
const kit = args[0] === "--kit";
const file = kit ? args[1] : args[0];
if (!file) throw new Error("Usage: vis-build.mts [--kit] <file>");
const entry = path.resolve(file);
const visKit = path.join(app, "client", "components", "vis-kit", "index.ts");

/** Kit mockups resolve `workbench/vis` to the kit, and React to the app's single copy even beside a project's own. */
const kitPlugin: import("esbuild").Plugin = {
  name: "workbench-vis-kit",
  setup(build) {
    build.onResolve({ filter: /^workbench\/vis$/ }, () => ({ path: visKit }));
    build.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: requireFromApp.resolve(args.path) }));
  },
};

const bundled = await esbuild.build({
  absWorkingDir: root,
  bundle: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  format: "iife",
  jsx: "automatic",
  logLevel: "silent",
  metafile: true,
  minify: true,
  // Repository mockups import project files by repository path (`app/client/...`); everything takes React from the app.
  nodePaths: kit ? [path.join(app, "node_modules")] : [root, path.join(app, "node_modules")],
  plugins: [...(kit ? [kitPlugin] : []), {
    name: "variant-groups",
    setup(build) {
      // esbuild filters are Go regular expressions, so no `u` flag.
      build.onLoad({ filter: /\.[jt]sx?$/ }, async (args) => {
        if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
        const source = await readFile(args.path, "utf8");
        const transformed = expandVariantGroupsInSource(source, args.path);
        return transformed.map ? { contents: transformed.code, loader: path.extname(args.path).slice(1) as "tsx" } : undefined;
      });
    },
  }],
  stdin: {
    contents: [
      `import { createElement } from "react";`,
      `import { createRoot } from "react-dom/client";`,
      `import Mockup from ${JSON.stringify(entry.replaceAll("\\", "/"))};`,
      `createRoot(document.getElementById("root")).render(createElement(Mockup));`,
    ].join("\n"),
    loader: "tsx",
    resolveDir: path.dirname(entry),
    sourcefile: "vis-entry.tsx",
  },
  target: ["es2022"],
  write: false,
});
const script = bundled.outputFiles[0]!.text;
const inputs = Object.keys(bundled.metafile.inputs).filter((input) => !input.startsWith("<stdin>") && !input.endsWith("vis-entry.tsx"));

// Nothing can be written, so the bundle's class-like tokens reach Tailwind inline; the app's own sources come from tailwind.css.
const candidates = [...new Set(script.match(/[^\s"'`<>{}\\]{2,}/gu) ?? [])].filter((token) => /[a-z]/u.test(token));
const tailwindInput = [
  `@import ${JSON.stringify(path.join(app, "client", "tailwind.css").replaceAll("\\", "/"))};`,
  `@source inline(${JSON.stringify(candidates.join(" "))});`,
].join("\n");
const css = await new Promise<string>((resolve, reject) => {
  const child = spawn(process.execPath, [tailwindCli, "--input", "-", "--minify"], { cwd: path.join(app, "client"), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Tailwind exited with code ${code}.\n${stderr.slice(0, 2_000)}`)));
  child.stdin.end(tailwindInput);
});

const document = [
  "<!doctype html><html><head><meta charset=\"utf-8\">",
  `<style>${css.replace(/<\/style/giu, "<\\/style")}</style>`,
  "</head><body class=\"bg-bg text-text\"><div id=\"root\"></div>",
  // `</script`, `<!--` and `<script` inside the bundle (Markdown handling has all three) would end or re-nest the
  // element; `\x3C` reads as `<` in every string, template and regular expression the minifier can emit.
  `<script>${script.replace(/<(?=\/script|!--|script)/giu, "\\x3C")}</script>`,
  "</body></html>",
].join("");
process.stdout.write(JSON.stringify({ document, inputs }));
