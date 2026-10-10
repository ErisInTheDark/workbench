/* No production exports. Pure wards for ordered edit operations: moves and their validation, reference rewrites, and regex replacements. */
import assert from "node:assert/strict";
import test from "node:test";

import { GitArcEditOperationSchema, type GitArcEditOperation } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import { runGitArcEditOperations, type GitArcEditWorkFile } from "./git-arc-edit-operations.ts";

const TS_IMPORTS = {
  aliases: { "@/": "src" },
  extensions: [".tsx", ".ts"],
  globs: ["*.ts", "*.tsx"],
  indexNames: ["index"],
  pattern: String.raw`(?:from|import)\s*\(?\s*['"](?<path>[^'"]+)['"]`,
};

function files(entries: Record<string, string | null>, ignored: string[] = []): GitArcEditWorkFile[] {
  return Object.entries(entries).map(([path, text]) => ({ ignored: ignored.includes(path), path, text }));
}

function run(input: GitArcEditWorkFile[], operations: object[], caseInsensitive = false) {
  return runGitArcEditOperations({
    caseInsensitive,
    files: input,
    operations: operations.map(operation => GitArcEditOperationSchema.parse(operation) as GitArcEditOperation),
  });
}

function textAt(result: ReturnType<typeof run>, path: string) {
  return result.changes.find(change => change.path === path)?.text;
}

test("identifier replacements honour word boundaries, capture groups, globs and roots", () => {
  const result = run(files({
    "src/a.tsx": "<ThreadMarkdown /><ThreadMarkdownSectionActions />",
    "src/b.ts": "ThreadMarkdown",
    "docs/c.tsx": "ThreadMarkdown",
  }), [
    { kind: "replace", pattern: String.raw`\bThreadMarkdown\b`, replacement: "ThreadMd", globs: ["*.tsx"], roots: ["src"] },
    { kind: "replace", pattern: String.raw`<(\w+) />`, replacement: "<$1/>", roots: ["src"] },
  ]);
  assert.equal(textAt(result, "src/a.tsx"), "<ThreadMd/><ThreadMarkdownSectionActions/>");
  assert.deepEqual(result.changes.map(change => change.path), ["src/a.tsx"]);
});

test("binary, unread and ignored files are never rewritten unless ignored files opt in", () => {
  const input = files({ "src/bin.dat": null, "src/a.ts": "token", ".local/a.ts": "token" }, [".local/a.ts"]);
  assert.deepEqual(run(input, [{ kind: "replace", pattern: "token", replacement: "x" }]).changes.map(change => change.path), ["src/a.ts"]);
  assert.deepEqual(
    run(input, [{ includeIgnored: true, kind: "replace", pattern: "token", replacement: "x" }]).changes.map(change => change.path),
    [".local/a.ts", "src/a.ts"],
  );
});

test("folder moves relocate every file and later operations see the new paths", () => {
  const result = run(files({ "src/old/a.ts": "A", "src/old/b.ts": "B", "src/keep.ts": "K" }), [
    { from: "src/old", kind: "move", to: "lib/new" },
    { kind: "replace", pattern: "A", replacement: "AA", roots: ["lib"] },
  ]);
  assert.deepEqual(result.changes, [
    { origin: "src/old/a.ts", path: "lib/new/a.ts", text: "AA" },
    { origin: "src/old/b.ts", path: "lib/new/b.ts" },
  ]);
});

test("pattern moves map matched files and skip unchanged matches", () => {
  const result = run(files({ "src/a.test.ts": "", "src/tests/b.test.ts": "", "src/c.ts": "" }), [
    { kind: "move", pathPattern: String.raw`^src/(?!tests/)(.+\.test\.ts)$`, pathReplacement: "src/tests/$1", roots: ["src"] },
  ]);
  assert.deepEqual(result.changes.map(({ origin, path }) => [origin, path]), [["src/a.test.ts", "src/tests/a.test.ts"]]);
});

test("moves reject missing sources, occupied destinations and destinations inside their source", () => {
  const input = files({ "src/a.ts": "", "src/b.ts": "", "lib/x.ts": "" });
  assert.throws(() => run(input, [{ from: "src/missing.ts", kind: "move", to: "lib/m.ts" }]), /does not exist/u);
  assert.throws(() => run(input, [{ from: "src/a.ts", kind: "move", to: "src/b.ts" }]), /already exists/u);
  assert.throws(() => run(input, [{ from: "src", kind: "move", to: "src/inner" }]), /inside its source/u);
  assert.throws(() => run(input, [{ from: "src/a.ts", kind: "move", to: "lib" }]), /folder with files/u);
  assert.throws(() => run(input, [{ kind: "move", pathPattern: "^src/(.+)$", pathReplacement: "lib/y.ts", roots: ["src"] }]), /repeated/u);
  assert.throws(() => run(input, [{ from: "src/a.ts", kind: "move", to: "../outside.ts" }]), /inside the repository/u);
});

test("case-only renames are allowed on case-insensitive filesystems", () => {
  const result = run(files({ "src/Widget.ts": "w" }), [{ from: "src/Widget.ts", kind: "move", to: "src/widget.ts" }], true);
  assert.deepEqual(result.changes, [{ origin: "src/Widget.ts", path: "src/widget.ts" }]);
});

test("references to a moved file are rewritten in their original form", () => {
  const result = run(files({
    "src/components/Widget.tsx": "export {}",
    "src/components/index.ts": "export {}",
    "src/app.tsx": [
      'import Widget from "./components/Widget";',
      'import "./components/Widget.js";',
      'import all from "./components";',
      'import alias from "@/components/Widget";',
      'import react from "react";',
    ].join("\n"),
  }), [
    { from: "src/components/Widget.tsx", kind: "move", references: [TS_IMPORTS], to: "src/ui/Widget.tsx" },
  ]);
  assert.equal(textAt(result, "src/app.tsx"), [
    'import Widget from "./ui/Widget";',
    'import "./ui/Widget.js";',
    'import all from "./components";',
    'import alias from "@/ui/Widget";',
    'import react from "react";',
  ].join("\n"));
  assert.deepEqual(result.warnings, []);
});

test("moved files rewrite their outgoing references, including references to other moved files", () => {
  const result = run(files({
    "src/a.ts": 'import { b } from "./b";\nimport { c } from "./shared/c";',
    "src/b.ts": "export const b = 1;",
    "src/shared/c.ts": "export const c = 1;",
  }), [
    { kind: "move", pathPattern: "^src/([ab])\\.ts$", pathReplacement: "src/feature/$1.ts", references: [TS_IMPORTS], roots: ["src"] },
  ]);
  assert.equal(textAt(result, "src/feature/a.ts"), 'import { b } from "./b";\nimport { c } from "../shared/c";');
});

test("folder index references keep their folder form and alias targets outside the alias root fall back to relative", () => {
  const result = run(files({
    "src/widgets/index.ts": "export {}",
    "src/app.ts": 'import w from "./widgets";\nimport v from "@/widgets";',
  }), [
    { from: "src/widgets", kind: "move", references: [TS_IMPORTS], to: "lib/widgets" },
  ]);
  assert.equal(textAt(result, "src/app.ts"), 'import w from "../lib/widgets";\nimport v from "../lib/widgets";');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /^src\/app\.ts:2 alias target left the @\/ root/u);
});

test("several reference specs cover different syntaxes in one move", () => {
  const markdown = { globs: ["*.md"], pattern: String.raw`\]\((?<path>[^)]+)\)` };
  const result = run(files({
    "src/Widget.tsx": "",
    "src/app.tsx": 'import W from "./Widget";',
    "docs/notes.md": "See [widget](../src/Widget.tsx).",
  }), [
    { from: "src/Widget.tsx", kind: "move", references: [TS_IMPORTS, markdown], to: "src/ui/Widget.tsx" },
  ]);
  assert.equal(textAt(result, "src/app.tsx"), 'import W from "./ui/Widget";');
  assert.equal(textAt(result, "docs/notes.md"), "See [widget](../src/ui/Widget.tsx).");
});

test("invalid patterns and reference specs without a path group reject before changing anything", () => {
  const input = files({ "src/a.ts": "" });
  assert.throws(() => run(input, [{ kind: "replace", pattern: "(", replacement: "" }]), /Invalid replace regex/u);
  assert.throws(() => run(input, [{ from: "src/a.ts", kind: "move", references: [{ pattern: "import" }], to: "src/b.ts" }]), /path>/u);
});
