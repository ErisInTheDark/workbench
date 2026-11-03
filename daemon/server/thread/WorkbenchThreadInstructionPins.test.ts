/*
 * No production exports. Tests prefix staleness: a moved tool catalogue or a rebuild that hashes differently is stale, the finding
 * lasts until the next base pin, and unpinned threads or failed rebuilds never count as stale.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { StoredThreadInstructionOverlays } from "../database/thread-state/WorkbenchThreadInstructionOverlayStore";
import WorkbenchThreadInstructionPins from "./WorkbenchThreadInstructionPins";

function fixture() {
  let stored: StoredThreadInstructionOverlays | null = null;
  const world = { tools: "tools-1", hash: "hash-1", rebuilds: 0, failRebuild: false };
  const pins = new WorkbenchThreadInstructionPins({
    execute: async command => {
      if (command.kind === "read") return stored;
      if (command.kind === "pinBase") stored = { base: structuredClone(command.layers), skills: stored?.skills ?? {}, prefix: structuredClone(command.prefix) };
      return null;
    },
    readToolRevision: () => world.tools,
    rebuildPrefixHash: async () => {
      world.rebuilds += 1;
      if (world.failRebuild) throw new Error("library unreadable");
      return world.hash;
    },
    warn: () => undefined,
  });
  const pinPrefix = () => pins.pin("t", { base: [], prefix: { hash: world.hash, context: { harness: "codex", model: null } } });
  return { pins, pinPrefix, world };
}

test("a fresh pin is not stale; a moved tool catalogue or changed instructions are, until the next pin", async () => {
  const { pins, pinPrefix, world } = fixture();
  await pinPrefix();
  assert.equal(await pins.prefixStale("t"), false);
  assert.equal(pins.knownPrefixStale("t"), false);

  world.hash = "hash-2";
  assert.equal(await pins.prefixStale("t"), true, "rebuilt instructions hash differently");
  assert.equal(pins.knownPrefixStale("t"), true, "remembered for observation without rebuilding");
  const rebuilds = world.rebuilds;
  assert.equal(await pins.prefixStale("t"), true);
  assert.equal(world.rebuilds, rebuilds, "a known staleness is not rebuilt again");

  await pinPrefix();
  assert.equal(pins.knownPrefixStale("t"), false, "the next build delivered the new prefix");
  world.tools = "tools-2";
  assert.equal(await pins.prefixStale("t"), true, "tools are part of the prefix");
});

test("unpinned threads, pins without a prefix and failed rebuilds never report stale", async () => {
  const { pins, pinPrefix, world } = fixture();
  assert.equal(await pins.prefixStale("t"), false);
  await pins.pin("t", { base: [], prefix: null });
  world.hash = "hash-2";
  assert.equal(await pins.prefixStale("t"), false);
  await pinPrefix();
  world.hash = "hash-3";
  world.failRebuild = true;
  assert.equal(await pins.prefixStale("t"), false);
  assert.equal(pins.knownPrefixStale("t"), false);
});
