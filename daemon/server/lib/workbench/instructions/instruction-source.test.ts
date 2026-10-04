/*
 * No production exports. Tests protect bundled instruction source and tombstone discovery.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { test } from "node:test";

import {
  readWorkbenchInstructionSources,
  readWorkbenchInstructionTombstones,
} from "./instruction-source";

test("instruction discovery separates empty tombstones from mirrored Markdown", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-instruction-source-");
  const rootPath = temporary.path;
  try {
    await mkdir(path.join(rootPath, "wb", "mechanics"), { recursive: true });
    await writeFile(path.join(rootPath, "wb", "mechanics", "active.md"), "# active\n", "utf8");
    await writeFile(path.join(rootPath, "wb", "mechanics", "thread-state.md.tombstone"), "\n", "utf8");

    assert.deepEqual(await readWorkbenchInstructionSources(rootPath), [{
      content: "# active",
      relativePath: "wb/mechanics/active.md",
    }]);
    assert.deepEqual(await readWorkbenchInstructionTombstones(rootPath), [{
      markerRelativePath: "wb/mechanics/thread-state.md.tombstone",
      targetRelativePath: "wb/mechanics/thread-state.md",
    }]);
  } finally {
    await temporary.dispose();
  }
});

test("instruction discovery rejects tombstones containing instructions", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-instruction-tombstone-");
  const rootPath = temporary.path;
  try {
    await writeFile(path.join(rootPath, "retired.md.tombstone"), "not empty\n", "utf8");
    await assert.rejects(
      readWorkbenchInstructionTombstones(rootPath),
      /Instruction tombstone must be empty.*retired\.md\.tombstone/u,
    );
  } finally {
    await temporary.dispose();
  }
});

test("instruction tombstones cannot target user-owned instruction files", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-instruction-user-owned-");
  const rootPath = temporary.path;
  try {
    await mkdir(path.join(rootPath, "agents"), { recursive: true });
    await writeFile(path.join(rootPath, "agents", "default.md.tombstone"), "", "utf8");
    await assert.rejects(
      readWorkbenchInstructionTombstones(rootPath),
      /cannot target a user-owned file.*agents\/default\.md/u,
    );
  } finally {
    await temporary.dispose();
  }
});
