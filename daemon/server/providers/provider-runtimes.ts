/*
 * Exports:
 * - ProviderRuntimeTarget/currentProviderRuntimeTarget: platform, arch and libc a runtime package must match.
 * - ProviderRuntimePin: npm package version plus the executable version it reports.
 * - ProviderRuntimePins/captureProviderRuntimePins: each provider's pin, read once when the daemon process starts.
 * - preloadProviderRuntimeClients: load lazily imported provider clients alongside their captured pins.
 * - ProviderRuntimeDefinition/providerRuntimeDefinitions: per-provider platform packages and executable path.
 * - InstalledProviderRuntime: committed `installed.json` marker of one runtime version.
 * - ProviderRuntimeDirectory: data-root runtime directory key; Codex shares the layout but is staged from the checkout.
 * - providerRuntimeRoot/providerRuntimeVersionRoot/readInstalledProviderRuntime: data-root layout and marker reads.
 * - PROVIDER_RUNTIME_STAGING_PREFIX/commitProviderRuntime/removeOtherProviderRuntimeVersions: verified staging commits and sweeps.
 * - probeExecutableVersion: what an executable prints for `--version`.
 * - ProviderRuntimeMissingError: ENOENT-coded failure pointing users at the Settings install action.
 * - resolveProviderRuntime: absolute executable and version of the runtime for a captured pin, or ProviderRuntimeMissingError.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { ProviderRuntimeKeySchema, type ProviderRuntimeKey } from "workbench-shared/workbench/provider/provider-runtime";

const run = promisify(execFile);

export interface ProviderRuntimeTarget {
  platform: NodeJS.Platform;
  arch: string;
  musl: boolean;
}

export interface ProviderRuntimePin {
  /** Version of the npm package to install. */
  packageVersion: string;
  /** Version the executable reports and Workbench shows. */
  version: string;
}

/**
 * Pins as this daemon process loaded them. A checkout dependency install must not move them before a restart,
 * since the in-memory SDK and client stay at the versions loaded at boot. A read rethrows a failed capture.
 */
export type ProviderRuntimePins = Record<ProviderRuntimeKey, () => ProviderRuntimePin>;

export interface ProviderRuntimeDefinition {
  label: string;
  /** Candidate platform packages in preference order; empty when the target is unsupported. */
  packages: (target: ProviderRuntimeTarget) => string[];
  /** Executable path inside the installed package directory. */
  executable: (target: ProviderRuntimeTarget) => string;
}

export interface InstalledProviderRuntime {
  packageName: string;
  packageVersion: string;
  version: string;
  /** Executable path relative to the runtime version directory. */
  executable: string;
}

export type ProviderRuntimeDirectory = ProviderRuntimeKey | "codex";

const MARKER = "installed.json";
export const PROVIDER_RUNTIME_STAGING_PREFIX = ".staging-";
const WINDOWS_LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const COMMIT_RENAME_RETRIES = 12;

export function currentProviderRuntimeTarget(): ProviderRuntimeTarget {
  const header = process.platform === "linux"
    ? (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
    : undefined;
  return { platform: process.platform, arch: process.arch, musl: process.platform === "linux" && !header?.glibcVersionRuntime };
}

/** Reads a dependency's manifest by location, since some packages do not export `package.json`. */
function readDependencyManifest(name: string): Record<string, unknown> {
  for (const directory of require.resolve.paths(name) ?? []) {
    const manifest = path.join(directory, name, "package.json");
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  }
  throw new Error(`Workbench's pinned ${name} dependency is not installed.`);
}

function manifestString(manifest: Record<string, unknown>, key: string, name: string) {
  const value = manifest[key];
  if (typeof value !== "string" || !value) throw new Error(`${name} has no ${key} in its package manifest.`);
  return value;
}

const pinSources: Record<ProviderRuntimeKey, () => ProviderRuntimePin> = {
  claude: () => {
    const name = "@anthropic-ai/claude-agent-sdk";
    const manifest = readDependencyManifest(name);
    // The SDK's platform packages share its version and carry the Claude Code build it was released with.
    return { packageVersion: manifestString(manifest, "version", name), version: manifestString(manifest, "claudeCodeVersion", name) };
  },
  opencode: () => {
    const name = "@opencode/client";
    // The client and CLI release in lockstep; the service rejects a mismatched server version.
    const version = manifestString(readDependencyManifest(name), "version", name);
    return { packageVersion: version, version };
  },
};

export function captureProviderRuntimePins(): ProviderRuntimePins {
  const captured = (read: () => ProviderRuntimePin): (() => ProviderRuntimePin) => {
    try {
      const pin = read();
      return () => pin;
    } catch (error) {
      return () => { throw error; };
    }
  };
  return Object.fromEntries(ProviderRuntimeKeySchema.options.map(key => [key, captured(pinSources[key])])) as ProviderRuntimePins;
}

/**
 * Loads provider clients that consumers import lazily. Node keeps a package's first resolution for the process,
 * so a checkout install cannot later hand them a client newer than the captured pin.
 */
export async function preloadProviderRuntimeClients() {
  await Promise.all([import("@opencode/client"), import("@opencode/client/service")]);
}

export const providerRuntimeDefinitions: Record<ProviderRuntimeKey, ProviderRuntimeDefinition> = {
  claude: {
    label: "Claude Code",
    packages: ({ platform, arch, musl }) => {
      if (!["x64", "arm64"].includes(arch) || !["win32", "linux", "darwin"].includes(platform)) return [];
      return [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}${platform === "linux" && musl ? "-musl" : ""}`];
    },
    executable: ({ platform }) => platform === "win32" ? "claude.exe" : "claude",
  },
  opencode: {
    label: "OpenCode",
    packages: ({ platform, arch, musl }) => {
      const os = ({ win32: "windows", linux: "linux", darwin: "darwin" } as Partial<Record<NodeJS.Platform, string>>)[platform];
      if (!os || !["x64", "arm64"].includes(arch)) return [];
      const base = `@opencode/cli-${os}-${arch}`;
      const libc = platform === "linux" && musl ? "-musl" : "";
      // x64 builds need AVX2; baseline builds are the fallback when the primary fails to run.
      return arch === "x64" ? [`${base}${libc}`, `${base}-baseline${libc}`] : [`${base}${libc}`];
    },
    executable: ({ platform }) => path.join("bin", platform === "win32" ? "opencode.exe" : "opencode"),
  },
};

export function providerRuntimeRoot(dataRoot: string, key: ProviderRuntimeDirectory) {
  return path.join(dataRoot, "daemon", "providers", key, "runtime");
}

export function providerRuntimeVersionRoot(dataRoot: string, key: ProviderRuntimeDirectory, packageVersion: string) {
  return path.join(providerRuntimeRoot(dataRoot, key), packageVersion);
}

/** The committed runtime under one version directory, or null when absent or incomplete. */
export function readInstalledProviderRuntime(versionRoot: string): InstalledProviderRuntime | null {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path.join(versionRoot, MARKER), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const marker = parsed as Partial<InstalledProviderRuntime> | null;
  if (!marker || typeof marker.packageName !== "string" || typeof marker.packageVersion !== "string"
    || typeof marker.version !== "string" || typeof marker.executable !== "string") {
    throw new Error(`Provider runtime marker at ${versionRoot} is malformed.`);
  }
  if (!existsSync(path.join(versionRoot, marker.executable))) return null;
  return marker as InstalledProviderRuntime;
}

export async function probeExecutableVersion(executable: string, signal?: AbortSignal) {
  const { stdout } = await run(executable, ["--version"], { signal, windowsHide: true });
  return stdout.trim();
}

/**
 * Marks a verified staging directory and renames it over the version directory, so readers only ever see a
 * committed runtime. Windows briefly locks freshly written files (antivirus, indexers, watchers), so a locked
 * rename backs off for up to ~17s before failing.
 */
export async function commitProviderRuntime(staging: string, versionRoot: string, marker: InstalledProviderRuntime, signal?: AbortSignal) {
  await writeFile(path.join(staging, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  await rm(versionRoot, { recursive: true, force: true });
  for (let attempt = 0; ; attempt++) {
    try { return await rename(staging, versionRoot); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !WINDOWS_LOCK_CODES.has(code) || attempt >= COMMIT_RENAME_RETRIES) throw error;
      await delay(Math.min(100 * 2 ** attempt, 2_000), undefined, { signal });
    }
  }
}

/** A running executable can hold an old version on Windows; the next commit sweeps it. */
export async function removeOtherProviderRuntimeVersions(root: string, keep: string, warn: (message: string) => void) {
  for (const entry of readdirSync(root).filter(name => name !== keep)) {
    await rm(path.join(root, entry), { recursive: true, force: true }).catch((error: unknown) => {
      warn(`Could not remove old runtime ${path.join(root, entry)}: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`);
    });
  }
}

export class ProviderRuntimeMissingError extends Error {
  readonly code = "ENOENT";

  constructor(label: string, version: string) {
    super(`${label} ${version} isn't installed on this daemon. Install it in Settings › Agents › Providers.`);
    this.name = "ProviderRuntimeMissingError";
  }
}

export function resolveProviderRuntime(dataRoot: string, key: ProviderRuntimeKey, pin: ProviderRuntimePin) {
  const versionRoot = providerRuntimeVersionRoot(dataRoot, key, pin.packageVersion);
  const installed = readInstalledProviderRuntime(versionRoot);
  if (!installed) throw new ProviderRuntimeMissingError(providerRuntimeDefinitions[key].label, pin.version);
  return { executable: path.join(versionRoot, installed.executable), version: installed.version };
}
