/*
 * No exports. Build the tray and safely publish its committed platform artifact.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { register } from "tsx/cjs/api";
import SetupCommand from "../package/SetupCommand.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRootPath = path.resolve(path.dirname(scriptPath), "..");
const trayRootPath = path.join(repositoryRootPath, "app", "tray");
const manifestPath = path.join(trayRootPath, "Cargo.toml");
const releaseDirectoryPath = path.join(trayRootPath, "target", "release");
async function runTrayBuild() {
  if (!["win32", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
    throw new Error(`Tray build is not configured for ${process.platform}/${process.arch}.`);
  }
  const name = process.platform === "win32" ? "workbench-tray.exe" : "workbench-tray";
  const platform = `${process.platform === "win32" ? "windows" : "linux"}-${process.arch}`;
  await new SetupCommand().run("cargo", ["build", "--release", "--manifest-path", manifestPath], { cwd: repositoryRootPath });
  const unregister = register();
  try {
    const Publisher = createRequire(import.meta.url)("../shared/process/NativeArtifactPublisher.ts").default;
    const destination = path.join(trayRootPath, "bin", platform, name);
    const artifact = await new Publisher().publish(path.join(releaseDirectoryPath, name), destination);
    console.log(`Updated ${path.relative(repositoryRootPath, destination)} (${artifact.size} bytes).`);
  } finally {
    unregister();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  void runTrayBuild().catch((error) => {
    console.error("Workbench tray build failed.");
    console.error(error);
    process.exitCode = 1;
  });
}
