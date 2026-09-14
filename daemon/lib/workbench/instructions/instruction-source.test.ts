/*
 * No production exports. Tests protect bundled instruction source and tombstone discovery.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  readWorkbenchInstructionSources,
  readWorkbenchInstructionTombstones,
} from "./instruction-source";

test("instruction discovery separates empty tombstones from mirrored Markdown", async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), "workbench-instruction-source-"));
  try {
    await mkdir(path.join(rootPath, "wb", "mechanics"), { recursive: true });
    await writeFile(path.join(rootPath, "wb", "mechanics", "active.md"), "# active\n", "utf8");
    await writeFile(path.join(rootPath, "wb", "mechanics", "thread-state.md.tombstone"), "\n", "utf8");

    assert.deepEqual(readWorkbenchInstructionSources(rootPath), [{
      content: "# active",
      relativePath: "wb/mechanics/active.md",
    }]);
    assert.deepEqual(readWorkbenchInstructionTombstones(rootPath), [{
      markerRelativePath: "wb/mechanics/thread-state.md.tombstone",
      targetRelativePath: "wb/mechanics/thread-state.md",
    }]);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("instruction discovery rejects tombstones containing instructions", async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), "workbench-instruction-tombstone-"));
  try {
    await writeFile(path.join(rootPath, "retired.md.tombstone"), "not empty\n", "utf8");
    assert.throws(
      () => readWorkbenchInstructionTombstones(rootPath),
      /Instruction tombstone must be empty.*retired\.md\.tombstone/u,
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("instruction tombstones cannot target user-owned instruction files", async () => {
  const rootPath = await mkdtemp(path.join(tmpdir(), "workbench-instruction-user-owned-"));
  try {
    await mkdir(path.join(rootPath, "agents"), { recursive: true });
    await writeFile(path.join(rootPath, "agents", "default.md.tombstone"), "", "utf8");
    assert.throws(
      () => readWorkbenchInstructionTombstones(rootPath),
      /cannot target a user-owned file.*agents\/default\.md/u,
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
