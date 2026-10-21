/*
 * Exports:
 * - No production exports; tests protect project-file conflict, mutation, forced creation, and containment behavior.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { test } from "node:test";

import WorkbenchProjectFileController from "./WorkbenchProjectFileController.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import type { ProjectFileSnapshot } from "workbench-shared/workbench/project/project-file";

const observedFile = (content: string): ProjectFileSnapshot => ({
  content, headContent: null, mtimeMs: 1, path: "note.md", projectId: "project",
  updatedAt: new Date(1).toISOString(), changeSummary: null,
});

test("file observations in plain folders survive atomic replacements", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("observed-plain-file-");
  const root = temporary.path;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  context.after(() => {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  });
  await fs.writeFile(path.join(root, "note.md"), "plain folder");
  const project = {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    kind: "git" as const, root, rootPath: root,
    roots: [{ id: "project", name: "project", root, rootPath: root }],
  };
  const owner = new WorkbenchProjectFileController(
    { resolveProjectById: async () => project },
    { refreshAfterFileMutation: async () => ({ changes: {} }) },
  );
  context.after(async () => { owner.dispose(); await temporary.dispose(); });
  const ready = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  const updated = Promise.withResolvers<void>();
  const handle = owner.observe("project", "note.md", () => {
    if (handle.read().data) ready.resolve();
    if (handle.read().data?.content === "replacement") replaced.resolve();
    if (handle.read().data?.content === "after replacement") updated.resolve();
  });
  await ready.promise;
  assert.equal(handle.read().data?.content, "plain folder");
  assert.equal(handle.read().phase, "current");
  await fs.writeFile(path.join(root, "replacement.md"), "replacement");
  await fs.rename(path.join(root, "replacement.md"), path.join(root, "note.md"));
  await replaced.promise;
  await fs.writeFile(path.join(root, "note.md"), "after replacement");
  await updated.promise;
  assert.equal(handle.read().phase, "current");
});

test("file observation shares demand and fences reads finishing after the last release", async () => {
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<ProjectFileSnapshot>();
  let watches = 0;
  let stops = 0;
  let publications = 0;
  const owner = new WorkbenchProjectFileController(
    { resolveProjectById: async () => { throw new Error("Injected observation owns its IO."); } },
    { refreshAfterFileMutation: async () => ({ changes: {} }) },
    {
      watch: async () => { watches++; return () => { stops++; }; },
      read: async () => { started.resolve(); return pending.promise; },
    },
  );
  const listener = () => { publications++; };
  const first = owner.observe("project", "note.md", listener);
  const second = owner.observe("project", "note.md", listener);
  await started.promise;
  assert.equal(watches, 1);
  first.release();
  assert.equal(stops, 0);
  second.release();
  assert.equal(stops, 1);
  pending.resolve(observedFile("late"));
  await pending.promise;
  assert.equal(publications, 0);
  assert.equal(first.read().data, null);
  owner.dispose();
});

test("file changes during a read coalesce and publish only the final read", async () => {
  const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const reads: Array<ReturnType<typeof Promise.withResolvers<ProjectFileSnapshot>>> = [];
  let changed = () => {};
  const publications: string[] = [];
  const published = Promise.withResolvers<void>();
  const owner = new WorkbenchProjectFileController(
    { resolveProjectById: async () => { throw new Error("Injected observation owns its IO."); } },
    { refreshAfterFileMutation: async () => ({ changes: {} }) },
    {
      watch: async (_project, _path, notify) => { changed = notify; return () => {}; },
      read: () => {
        const pending = Promise.withResolvers<ProjectFileSnapshot>();
        reads.push(pending);
        starts[reads.length - 1]!.resolve();
        return pending.promise;
      },
    },
  );
  const handle = owner.observe("project", "note.md", () => {
    publications.push(handle.read().data?.content ?? "");
    published.resolve();
  });
  await starts[0]!.promise;
  changed();
  changed();
  reads[0]!.resolve(observedFile("superseded"));
  await starts[1]!.promise;
  assert.deepEqual(publications, []);
  reads[1]!.resolve(observedFile("latest"));
  await published.promise;
  assert.deepEqual(publications, ["latest"]);
  assert.equal(reads.length, 2);
  handle.release();
  owner.dispose();
});

test("file writes preserve mtime conflicts and refresh snapshots only after mutation", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-project-file-");
  const root = temporary.path;
  const filePath = path.join(root, "note.md");
  await fs.writeFile(filePath, "before", "utf8");
  const project = {
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    kind: "git" as const,
    root,
    rootPath: root,
    roots: [{ id: "project", name: "project", root, rootPath: root }],
  };
  let refreshes = 0;
  const controller = new WorkbenchProjectFileController(
    { resolveProjectById: async () => project },
    {
      refreshAfterFileMutation: async () => {
        refreshes += 1;
        return { changes: {} };
      },
    },
  );
  try {
    const mtimeMs = Math.trunc((await fs.stat(filePath)).mtimeMs);
    const conflict = await controller.write({
      content: "blocked",
      expectedMtimeMs: mtimeMs - 1,
      path: "note.md",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      resetToHead: false,
    });
    assert.equal("error" in conflict, true);
    assert.equal(await fs.readFile(filePath, "utf8"), "before");
    assert.equal(refreshes, 0);

    const saved = await controller.write({
      content: "after",
      expectedMtimeMs: mtimeMs,
      path: "note.md",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      resetToHead: false,
    });
    assert.equal("changes" in saved, true);
    assert.equal(await fs.readFile(filePath, "utf8"), "after");
    assert.equal(refreshes, 1);

    await assert.rejects(
      controller.write({
        content: "escape",
        expectedMtimeMs: 0,
        force: true,
        path: "../outside.md",
        projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
        resetToHead: false,
      }),
      /outside the project (?:root|workspace)/u,
    );

    const write = (relative: string, force: boolean) => controller.write({
      content: "<svg/>", expectedMtimeMs: 0, force, path: relative,
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), resetToHead: false,
    });
    await assert.rejects(write("icon.svg", false), /ENOENT/u);
    assert.equal("changes" in await write("icon.svg", true), true);
    assert.equal(await fs.readFile(path.join(root, "icon.svg"), "utf8"), "<svg/>");
    await assert.rejects(write("image.png", true), /can be edited/u);
  } finally {
    await temporary.dispose();
  }
});
