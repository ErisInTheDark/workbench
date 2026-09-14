/*
 * Exports:
 * - No production exports. Tests protect icon ranking, Git-visible admission, moved assets and invalid repository markers.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  discoverWorkbenchProjectIcon,
  selectWorkbenchProjectIcon,
} from "./project-icon-discovery.ts";

const execFileAsync = promisify(execFile);

test("selects project icons by preference before root, depth, and lexical order", () => {
  const roots = [{ id: "first" }, { id: "second" }];
  assert.deepEqual(selectWorkbenchProjectIcon(roots, [
    ["deep/path/favicon.png", "favicon.png"],
    ["favicon-dark.png"],
  ]), { path: "favicon.png", rootId: "first" });
  assert.deepEqual(selectWorkbenchProjectIcon(roots, [
    ["icon.png"],
    ["nested/favicon-dark.png"],
  ]), { path: "nested/favicon-dark.png", rootId: "second" });
  assert.deepEqual(selectWorkbenchProjectIcon(roots, [
    ["icons/main.png", "icon/default.png"],
    ["favicon.ico"],
  ]), { path: "favicon.ico", rootId: "second" });
  assert.deepEqual(selectWorkbenchProjectIcon(roots, [
    ["icons/main.png", "icons/default.png"],
    [],
  ]), { path: "icons/default.png", rootId: "first" });
});

test("discovers tracked and non-ignored untracked icons without admitting ignored files", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-project-icon-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  await fs.mkdir(path.join(root, "ignored"), { recursive: true });
  await fs.mkdir(path.join(root, "public"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf8");
  await fs.writeFile(path.join(root, "ignored", "favicon.png"), "ignored", "utf8");
  await fs.writeFile(path.join(root, "public", "favicon-dark.png"), "untracked", "utf8");
  await fs.writeFile(path.join(root, "src", "icon.png"), "tracked", "utf8");
  await execFileAsync("git", ["add", "--", ".gitignore", "src/icon.png"], { cwd: root, windowsHide: true });

  assert.deepEqual(await discoverWorkbenchProjectIcon([{
    id: "project",
    rootPath: root,
  }]), {
    path: "public/favicon-dark.png",
    rootId: "project",
  });
});

test("discovers a moved icon instead of its deleted tracked path", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-project-icon-moved-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  await fs.writeFile(path.join(root, "favicon.png"), "icon", "utf8");
  await execFileAsync("git", ["add", "--", "favicon.png"], { cwd: root, windowsHide: true });
  await fs.mkdir(path.join(root, "assets"));
  await fs.rename(path.join(root, "favicon.png"), path.join(root, "assets/favicon.png"));
  const roots = [{ id: "project", rootPath: root }];

  assert.deepEqual(await discoverWorkbenchProjectIcon(roots), {
    path: "assets/favicon.png",
    rootId: "project",
  });
  await fs.unlink(path.join(root, "assets/favicon.png"));
  assert.equal(await discoverWorkbenchProjectIcon(roots), null);
});

test("treats an invalid Git marker as a project without an icon", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-project-icon-invalid-git-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  await fs.mkdir(path.join(root, ".git"));

  assert.equal(await discoverWorkbenchProjectIcon([{
    id: "project",
    rootPath: root,
  }]), null);
});
