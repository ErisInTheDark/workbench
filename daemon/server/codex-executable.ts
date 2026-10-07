/*
 * Exports:
 * - default resolveCodexExecutable: absolute native Codex binary from the daemon's pinned `@openai/codex` dependency.
 */
import { createRequire } from "node:module";
import path from "node:path";

// Mirrors `@openai/codex/bin/codex.js`; the npm launcher is skipped so the daemon owns the native process directly.
const TARGETS: Partial<Record<string, { triple: string; packageName: string }>> = {
  "linux-x64": { triple: "x86_64-unknown-linux-musl", packageName: "@openai/codex-linux-x64" },
  "linux-arm64": { triple: "aarch64-unknown-linux-musl", packageName: "@openai/codex-linux-arm64" },
  "darwin-x64": { triple: "x86_64-apple-darwin", packageName: "@openai/codex-darwin-x64" },
  "darwin-arm64": { triple: "aarch64-apple-darwin", packageName: "@openai/codex-darwin-arm64" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", packageName: "@openai/codex-win32-x64" },
  "win32-arm64": { triple: "aarch64-pc-windows-msvc", packageName: "@openai/codex-win32-arm64" },
};

/**
 * A missing platform package still yields its expected path, so the spawn fails with an ordinary ENOENT;
 * a missing `@openai/codex` package throws an ENOENT-coded error. Recovery treats both as a missing installation.
 */
export default function resolveCodexExecutable(platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`Codex has no native build for ${platform}-${arch}.`);
  let codexManifest: string;
  try { codexManifest = require.resolve("@openai/codex/package.json"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    // Same classification as a missing binary: reinstalling dependencies is the only remedy.
    throw Object.assign(new Error("Workbench's pinned @openai/codex dependency is not installed.", { cause: error }), { code: "ENOENT" });
  }
  let vendorRoot = path.join(path.dirname(codexManifest), "vendor");
  try {
    vendorRoot = path.join(path.dirname(createRequire(codexManifest).resolve(`${target.packageName}/package.json`)), "vendor");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  }
  return path.join(vendorRoot, target.triple, "bin", platform === "win32" ? "codex.exe" : "codex");
}
