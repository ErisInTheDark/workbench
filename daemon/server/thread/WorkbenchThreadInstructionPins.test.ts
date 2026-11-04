/*
 * No production exports. Tests prefix staleness: served tool specs or a rebuild that hashes differently are stale, the finding lasts
 * until the next base pin, a restarted daemon serving the same content is fresh, and unpinned threads, unreadable tools or failed
 * rebuilds never count as stale.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { StoredThreadInstructionOverlays } from "../database/thread-state/WorkbenchThreadInstructionOverlayStore";
import WorkbenchThreadInstructionPins from "./WorkbenchThreadInstructionPins";

function fixture() {
  const storage: { row: StoredThreadInstructionOverlays | null } = { row: null };
  const world = { tools: "tools-1", hash: "hash-1", rebuilds: 0, failRebuild: false, failTools: false };
  const create = () => new WorkbenchThreadInstructionPins({
    execute: async command => {
      if (command.kind === "read") return storage.row;
      if (command.kind === "pinBase") {
        storage.row = { base: structuredClone(command.layers), skills: storage.row?.skills ?? {}, prefix: structuredClone(command.prefix) };
      }
      return null;
    },
    readToolFingerprint: async () => {
      if (world.failTools) throw new Error("mcp unavailable");
      return world.tools;
    },
    rebuildPrefixHash: async () => {
      world.rebuilds += 1;
      if (world.failRebuild) throw new Error("library unreadable");
      return world.hash;
    },
    warn: () => undefined,
  });
  const pins = create();
  const pinPrefix = (target = pins) => target.pin("t", { base: [], prefix: { hash: world.hash, context: { harness: "codex", model: null } } });
  return { create, pins, pinPrefix, storage, world };
}

test("a fresh pin is not stale; changed served tools or instructions are, until the next pin", async () => {
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
  assert.equal(await pins.prefixStale("t"), true, "served tools are part of the prefix");
});

test("a restarted daemon serving the same tools and instructions finds the pinned prefix fresh", async () => {
  const { create, pinPrefix } = fixture();
  await pinPrefix();
  assert.equal(await create().prefixStale("t"), false);
});

test("prefixes pinned without a tool fingerprint compare only their instructions", async () => {
  const { pins, pinPrefix, storage, world } = fixture();
  world.failTools = true;
  await pinPrefix();
  assert.ok(storage.row?.prefix, "an unreadable tool catalogue still pins the instructions");
  world.failTools = false;
  world.tools = "tools-2";
  assert.equal(await pins.prefixStale("t"), false, "unknown tools are never judged stale");
  world.hash = "hash-2";
  assert.equal(await pins.prefixStale("t"), true);

  const { pins: legacy, storage: legacyStorage, world: legacyWorld } = fixture();
  legacyStorage.row = { base: [], skills: {}, prefix: { hash: "hash-1", toolRevision: "epoch:3", context: { harness: "codex", model: null } } };
  legacyWorld.tools = "anything";
  assert.equal(await legacy.prefixStale("t"), false, "a legacy serial revision is ignored");
});

test("unpinned threads, pins without a prefix and failed reads never report stale", async () => {
  const { pins, pinPrefix, world } = fixture();
  assert.equal(await pins.prefixStale("t"), false);
  await pins.pin("t", { base: [], prefix: null });
  world.hash = "hash-2";
  assert.equal(await pins.prefixStale("t"), false);
  await pinPrefix();
  world.hash = "hash-3";
  world.failRebuild = true;
  assert.equal(await pins.prefixStale("t"), false);
  world.failRebuild = false;
  world.failTools = true;
  assert.equal(await pins.prefixStale("t"), false);
  assert.equal(pins.knownPrefixStale("t"), false);
});
