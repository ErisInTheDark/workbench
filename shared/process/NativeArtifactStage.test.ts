/* No production exports. Protect data-root staging, reuse, replacement and image validation. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory.ts";
import NativeArtifactStage from "./NativeArtifactStage.ts";

function nativeImage(platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  const buffer = Buffer.alloc(128);
  if (platform === "win32") {
    buffer.writeUInt16LE(0x5a4d, 0);
    buffer.writeUInt32LE(0x40, 0x3c);
    buffer.writeUInt32LE(0x4550, 0x40);
    buffer.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 0x44);
  } else {
    buffer.write("7f454c46", 0, "hex");
    buffer[4] = 2;
    buffer[5] = 1;
    buffer.writeUInt16LE(arch === "x64" ? 62 : 183, 18);
  }
  return buffer;
}

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-native-stage-");
  context.after(() => temporary.dispose());
  const source = path.join(temporary.path, "source");
  const runtimeRoot = path.join(temporary.path, "runtime");
  const name = process.platform === "win32" ? "workbench-network.exe" : "workbench-network";
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, name), nativeImage());
  return { source, runtimeRoot, name, executable: path.join(source, name) };
}

test("stages a committed artifact into the data root and reuses it without rewriting", async context => {
  const { runtimeRoot, name, executable } = await fixture(context);
  const stage = new NativeArtifactStage({ runtimeRoot });
  const staged = await stage.stage({ label: "network", executable });
  assert.equal(staged, path.join(runtimeRoot, "native", "network", name));
  const first = await fs.stat(staged);
  await stage.stage({ label: "network", executable });
  const second = await fs.stat(staged);
  assert.equal(second.mtimeMs, first.mtimeMs, "an unchanged artifact must not be rewritten");
});

test("republishes changed bytes and clears retired leftovers", async context => {
  const { runtimeRoot, name, executable } = await fixture(context);
  const directory = path.join(runtimeRoot, "native", "network");
  const stage = new NativeArtifactStage({ runtimeRoot });
  await stage.stage({ label: "network", executable });
  const changed = nativeImage();
  changed[120] = 7;
  await fs.writeFile(executable, changed);
  await fs.writeFile(path.join(directory, `${name}.retired-deadbeef`), "stale");
  const staged = await stage.stage({ label: "network", executable });
  assert.deepEqual(await fs.readFile(staged), changed);
  await assert.rejects(fs.access(path.join(directory, `${name}.retired-deadbeef`)), /ENOENT/u);
});

test("stages companion files as one set", async context => {
  const { source, runtimeRoot, executable } = await fixture(context);
  const companion = path.join(source, process.platform === "win32" ? "sherpa.dll" : "libsherpa.so");
  await fs.writeFile(companion, nativeImage());
  const stage = new NativeArtifactStage({ runtimeRoot });
  const files = [path.basename(executable), path.basename(companion)];
  const staged = await stage.stage({ label: "voice", executable, files });
  await fs.access(path.join(path.dirname(staged), path.basename(companion)));
  const receipt = JSON.parse(await fs.readFile(path.join(runtimeRoot, "native", "voice", "stage.json"), "utf8")) as { files: string[] };
  assert.deepEqual([...receipt.files].sort(), [...files].sort());
});

test("rejects an image built for another architecture", async context => {
  const { source, runtimeRoot } = await fixture(context);
  const wrong = path.join(source, process.platform === "win32" ? "wrong.dll" : "libwrong.so");
  await fs.writeFile(wrong, nativeImage(process.platform, process.arch === "arm64" ? "x64" : "arm64"));
  const stage = new NativeArtifactStage({ runtimeRoot });
  await assert.rejects(stage.stage({ label: "wrong", executable: wrong }), /invalid/u);
});
