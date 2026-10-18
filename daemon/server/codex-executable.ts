/*
 * Exports:
 * - CodexRuntimeStageOptions: data root plus injectable platform, package source and executable probe.
 * - default stageCodexRuntime: copy the daemon's pinned Codex platform package into the data root once per version and resolve its binary there.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  PROVIDER_RUNTIME_STAGING_PREFIX,
  commitProviderRuntime,
  probeExecutableVersion,
  providerRuntimeRoot,
  providerRuntimeVersionRoot,
  readInstalledProviderRuntime,
  removeOtherProviderRuntimeVersions,
} from "./providers/provider-runtimes";

// Mirrors `@openai/codex/bin/codex.js`; the npm launcher is skipped so the daemon owns the native process directly.
const TARGETS: Partial<Record<string, { triple: string; packageName: string }>> = {
  "linux-x64": { triple: "x86_64-unknown-linux-musl", packageName: "@openai/codex-linux-x64" },
  "linux-arm64": { triple: "aarch64-unknown-linux-musl", packageName: "@openai/codex-linux-arm64" },
  "darwin-x64": { triple: "x86_64-apple-darwin", packageName: "@openai/codex-darwin-x64" },
  "darwin-arm64": { triple: "aarch64-apple-darwin", packageName: "@openai/codex-darwin-arm64" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", packageName: "@openai/codex-win32-x64" },
  "win32-arm64": { triple: "aarch64-pc-windows-msvc", packageName: "@openai/codex-win32-arm64" },
};

export interface CodexRuntimeStageOptions {
  dataRoot: string;
  warn: (message: string) => void;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Path of the pinned `@openai/codex` manifest; throws MODULE_NOT_FOUND when the package is missing. */
  resolveManifest?: () => string;
  probe?: (executable: string) => Promise<string>;
}

interface CodexPackage {
  version: string;
  /** The platform package's `vendor/<triple>` tree: the binary plus helpers it finds beside itself. */
  tree: string;
}

function locateCodexPackage(target: { triple: string; packageName: string }, resolveManifest: () => string): CodexPackage {
  let manifest: string;
  try { manifest = resolveManifest(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    // Same classification as a missing binary: reinstalling dependencies is the only remedy.
    throw Object.assign(new Error("Workbench's pinned @openai/codex dependency is not installed.", { cause: error }), { code: "ENOENT" });
  }
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
  if (typeof version !== "string" || !version) throw new Error("@openai/codex has no version in its package manifest.");
  let vendorRoot = path.join(path.dirname(manifest), "vendor");
  try {
    vendorRoot = path.join(path.dirname(createRequire(manifest).resolve(`${target.packageName}/package.json`)), "vendor");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  }
  return { version, tree: path.join(vendorRoot, target.triple) };
}

/**
 * Runs once per daemon process, before any Codex spawn. Codex runs from its data-root copy so a checkout
 * dependency install never deletes or replaces a running binary, and only a restart adopts a new pin.
 * A missing package or binary still resolves to its expected path, so spawning fails with an ordinary ENOENT
 * that recovery treats as a missing installation. A failed copy keeps Codex running from the checkout.
 */
export default async function stageCodexRuntime(options: CodexRuntimeStageOptions): Promise<() => string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) {
    const unsupported = new Error(`Codex has no native build for ${platform}-${arch}.`);
    return () => { throw unsupported; };
  }
  let source: CodexPackage;
  try { source = locateCodexPackage(target, options.resolveManifest ?? (() => require.resolve("@openai/codex/package.json"))); }
  catch (error) { return () => { throw error; }; }
  const executable = path.join("bin", platform === "win32" ? "codex.exe" : "codex");
  const root = providerRuntimeRoot(options.dataRoot, "codex");
  const versionRoot = providerRuntimeVersionRoot(options.dataRoot, "codex", source.version);
  const staged = () => path.join(versionRoot, executable);
  try {
    if (readInstalledProviderRuntime(versionRoot)) return staged;
    await mkdir(root, { recursive: true });
    const staging = await mkdtemp(path.join(root, PROVIDER_RUNTIME_STAGING_PREFIX));
    try {
      // `cp` keeps each file's mode, so Unix helpers stay executable.
      await cp(source.tree, staging, { recursive: true, verbatimSymlinks: true });
      const reported = await (options.probe ?? probeExecutableVersion)(path.join(staging, executable));
      if (!reported.includes(source.version)) throw new Error(`Codex reported "${reported.slice(0, 120)}" instead of ${source.version}.`);
      await commitProviderRuntime(staging, versionRoot, {
        packageName: target.packageName, packageVersion: source.version, version: source.version, executable,
      });
    } catch (error) {
      await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch((cleanup: unknown) => {
        options.warn(`Could not remove Codex staging ${staging}: ${cleanup instanceof Error ? cleanup.message.slice(0, 300) : String(cleanup)}`);
      });
      throw error;
    }
    await removeOtherProviderRuntimeVersions(root, source.version, options.warn);
    return staged;
  } catch (error) {
    const sourceExecutable = path.join(source.tree, executable);
    options.warn(`Codex ${source.version} could not be staged; running it from the checkout. ${
      error instanceof Error ? error.message.slice(0, 500) : String(error)}`);
    return () => sourceExecutable;
  }
}
