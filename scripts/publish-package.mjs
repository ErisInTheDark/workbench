/*
 * Exports:
 * - preparePackagePublication: verify the committed version and copy the repository README into the npm package.
 * - runPackagePublication: prepare and run npm pack or publish from the package directory.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WorkbenchBootstrapCommand from "../package/WorkbenchBootstrapCommand.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function preparePackagePublication({ root = repositoryRoot, expectedVersion } = {}) {
  const packageDirectory = path.join(root, "package");
  const manifest = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"));
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    throw new Error(`Expected @inthedark/wb ${expectedVersion}, but package/package.json contains ${manifest.version}.`);
  }
  await fs.copyFile(path.join(root, "README.md"), path.join(packageDirectory, "README.md"));
  return { packageDirectory, version: manifest.version };
}

export async function runPackagePublication({
  mode,
  expectedVersion,
  root = repositoryRoot,
  commands = new WorkbenchBootstrapCommand(),
}) {
  if (!["pack", "publish"].includes(mode)) throw new Error("Package publication mode must be pack or publish.");
  const prepared = await preparePackagePublication({ root, expectedVersion });
  await commands.run("npm", mode === "publish"
    ? ["publish"]
    : ["pack", "--pack-destination", prepared.packageDirectory], {
    cwd: prepared.packageDirectory,
    interactive: true,
  });
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const mode = args.shift();
    const versionFlag = args.shift();
    const expectedVersion = args.shift();
    if (!["--pack", "--publish"].includes(mode) || args.length
      || (mode === "--publish" && (versionFlag !== "--version" || !expectedVersion))
      || (mode === "--pack" && versionFlag !== undefined)) {
      throw new Error("Usage: publish-package.mjs --pack | --publish --version <committed-version>");
    }
    await runPackagePublication({ mode: mode.slice(2), expectedVersion });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
