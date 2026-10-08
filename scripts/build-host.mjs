/*
 * No exports. Build and publish the committed Windows service supervisor.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { register } from "tsx/cjs/api";
import { runCommand } from "./run-command.mjs";

if (process.platform !== "win32") {
  throw new Error("Linux daemon hosting uses systemd; it does not require the Windows supervisor binary.");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(root, "daemon", "host", "native");
await runCommand("cargo", ["build", "--release", "--manifest-path", path.join(project, "Cargo.toml")], { cwd: root });
const unregister = register();
try {
  const Publisher = createRequire(import.meta.url)("../shared/process/NativeArtifactPublisher.ts").default;
  const target = path.join(root, "daemon", "host", "bin", `windows-${process.arch}`, "workbench-daemon-host.exe");
  const result = await new Publisher().publish(path.join(project, "target", "release", "workbench-daemon-host.exe"), target);
  console.log(`Updated ${path.relative(root, target)} (${result.size} bytes).`);
} finally {
  unregister();
}
