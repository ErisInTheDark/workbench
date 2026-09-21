/*
 * No production exports. Tests validated native publication preserves usable artifacts.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import NativeArtifactPublisher from "./NativeArtifactPublisher.ts";

function windowsImage() {
  const image = Buffer.alloc(128);
  image.writeUInt16LE(0x5a4d);
  image.writeUInt32LE(64, 0x3c);
  image.writeUInt32LE(0x4550, 64);
  image.writeUInt16LE(0x8664, 68);
  return image;
}

test("invalid artifacts cannot replace the current launcher", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-native-publish-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "built.exe");
  const destination = path.join(root, "committed.exe");
  await fs.writeFile(source, "truncated");
  await fs.writeFile(destination, "keep");
  const publisher = new NativeArtifactPublisher({ platform: "win32", arch: "x64" });
  await assert.rejects(publisher.publish(source, destination), /executable|PE/i);
  assert.equal(await fs.readFile(destination, "utf8"), "keep");
});

test("validated artifacts replace the previous image without leaving candidates", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-native-publish-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "built.exe");
  const destination = path.join(root, "committed.exe");
  const image = windowsImage();
  await fs.writeFile(source, image);
  await fs.writeFile(destination, "previous");
  await new NativeArtifactPublisher({ platform: "win32", arch: "x64" }).publish(source, destination);
  assert.deepEqual(await fs.readFile(destination), image);
  assert.deepEqual((await fs.readdir(root)).sort(), ["built.exe", "committed.exe"]);
});
