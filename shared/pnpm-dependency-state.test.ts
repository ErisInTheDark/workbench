/*
 * No exports. Protects which installed packages each process's dependency closure covers, and when installs drift.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import WorkbenchTemporaryDirectory from "./WorkbenchTemporaryDirectory.ts";
import { hasDependencyDrift, lockfileClosure, readDependencyFingerprint } from "./pnpm-dependency-state.mjs";

const ENVIRONMENT_DOCUMENT = [
  "---", "lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    packageManagerDependencies:",
  "      pnpm:", "        specifier: 11.22.0", "        version: 11.22.0", "", "snapshots:", "", "  pnpm@11.22.0: {}", "", "---",
].join("\n");

function lockfile({ react = "19.1.0", environment = false } = {}) {
  return [
    ...(environment ? [ENVIRONMENT_DOCUMENT] : []),
    "lockfileVersion: '9.0'", "", "importers:", "",
    "  .:", "    devDependencies:",
    "      node:", "        specifier: runtime:26.9.0", "        version: runtime:26.9.0", "",
    "  app:", "    dependencies:",
    "      react-dom:", `        specifier: ${react}`, `        version: ${react}(react@${react})`,
    "      workbench-shared:", "        specifier: workspace:*", "        version: link:../shared",
    "      string-width-cjs:", "        specifier: npm:string-width@^4", "        version: string-width@4.2.3", "",
    "  daemon:", "    dependencies:",
    "      zod:", "        specifier: 4.3.6", "        version: 4.3.6", "",
    "snapshots:", "",
    `  react-dom@${react}(react@${react}):`, "    dependencies:", `      react: ${react}`, "      scheduler: 0.26.0", "",
    `  react@${react}: {}`, "", "  scheduler@0.26.0: {}", "", "  string-width@4.2.3: {}", "",
    "  zod@4.3.6:", "    optional: true", "    transitivePeerDependencies:", "      - supports-color", "",
  ].join("\n");
}

test("closures follow transitive and peer-suffixed snapshots and alias targets, skipping links and runtimes", () => {
  assert.deepEqual(lockfileClosure(lockfile(), ["app"]), [
    "react-dom@19.1.0(react@19.1.0)", "react@19.1.0", "scheduler@0.26.0", "string-width@4.2.3",
  ]);
  assert.deepEqual(lockfileClosure(lockfile(), ["."]), []);
});

test("an app-only bump changes the app fingerprint but not the daemon one, ignoring vp's environment document", async (context) => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-dependency-state-");
  context.after(() => temporary.dispose());
  const root = temporary.path;
  await fs.mkdir(path.join(root, "node_modules", ".pnpm"), { recursive: true });
  const write = async (wanted: string, installed: string) => {
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), wanted);
    await fs.writeFile(path.join(root, "node_modules", ".pnpm", "lock.yaml"), installed);
  };
  await write(lockfile({ environment: true }), lockfile());
  assert.equal(await hasDependencyDrift(root), false);

  const before = { app: await readDependencyFingerprint(root, "wanted", ["app"]),
    daemon: await readDependencyFingerprint(root, "wanted", ["daemon"]) };
  await write(lockfile({ environment: true, react: "19.2.0" }), lockfile());
  assert.notEqual(await readDependencyFingerprint(root, "wanted", ["app"]), before.app);
  assert.equal(await readDependencyFingerprint(root, "wanted", ["daemon"]), before.daemon);
  assert.equal(await hasDependencyDrift(root), true);
  assert.equal(await hasDependencyDrift(root, ["daemon"]), false);
});

test("missing installed dependencies drift; a missing lockfile does not", async (context) => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-dependency-state-missing-");
  context.after(() => temporary.dispose());
  assert.equal(await hasDependencyDrift(temporary.path), false);
  await fs.writeFile(path.join(temporary.path, "pnpm-lock.yaml"), lockfile());
  assert.equal(await hasDependencyDrift(temporary.path), true);
});
