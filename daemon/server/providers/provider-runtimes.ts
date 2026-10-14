/*
 * Exports:
 * - ProviderRuntimeTarget/currentProviderRuntimeTarget: platform, arch and libc a runtime package must match.
 * - ProviderRuntimePin: npm package version plus the executable version it reports.
 * - ProviderRuntimeDefinition/providerRuntimeDefinitions: per-provider pin source, platform packages and executable path.
 * - InstalledProviderRuntime: committed `installed.json` marker of one runtime version.
 * - providerRuntimeRoot/providerRuntimeVersionRoot/providerRuntimeMarkerPath/readInstalledProviderRuntime: data-root layout and marker reads.
 * - ProviderRuntimeMissingError: ENOENT-coded failure pointing users at the Settings install action.
 * - resolveProviderRuntime: absolute executable and version of the runtime pinned by this checkout, or ProviderRuntimeMissingError.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProviderRuntimeKey } from "workbench-shared/workbench/provider/provider-runtime";

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

export interface ProviderRuntimeDefinition {
  label: string;
  readPin: () => ProviderRuntimePin;
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

const MARKER = "installed.json";

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

export const providerRuntimeDefinitions: Record<ProviderRuntimeKey, ProviderRuntimeDefinition> = {
  claude: {
    label: "Claude Code",
    readPin: () => {
      const name = "@anthropic-ai/claude-agent-sdk";
      const manifest = readDependencyManifest(name);
      // The SDK's platform packages share its version and carry the Claude Code build it was released with.
      return { packageVersion: manifestString(manifest, "version", name), version: manifestString(manifest, "claudeCodeVersion", name) };
    },
    packages: ({ platform, arch, musl }) => {
      if (!["x64", "arm64"].includes(arch) || !["win32", "linux", "darwin"].includes(platform)) return [];
      return [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}${platform === "linux" && musl ? "-musl" : ""}`];
    },
    executable: ({ platform }) => platform === "win32" ? "claude.exe" : "claude",
  },
  opencode: {
    label: "OpenCode",
    readPin: () => {
      const name = "@opencode/client";
      // The client and CLI release in lockstep; the service rejects a mismatched server version.
      const version = manifestString(readDependencyManifest(name), "version", name);
      return { packageVersion: version, version };
    },
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

export function providerRuntimeRoot(dataRoot: string, key: ProviderRuntimeKey) {
  return path.join(dataRoot, "daemon", "providers", key, "runtime");
}

export function providerRuntimeVersionRoot(dataRoot: string, key: ProviderRuntimeKey, packageVersion: string) {
  return path.join(providerRuntimeRoot(dataRoot, key), packageVersion);
}

export function providerRuntimeMarkerPath(versionRoot: string) {
  return path.join(versionRoot, MARKER);
}

/** The committed runtime under one version directory, or null when absent or incomplete. */
export function readInstalledProviderRuntime(versionRoot: string): InstalledProviderRuntime | null {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(providerRuntimeMarkerPath(versionRoot), "utf8")); }
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

export class ProviderRuntimeMissingError extends Error {
  readonly code = "ENOENT";

  constructor(label: string, version: string) {
    super(`${label} ${version} isn't installed on this daemon. Install it in Settings › Agents › Providers.`);
    this.name = "ProviderRuntimeMissingError";
  }
}

export function resolveProviderRuntime(dataRoot: string, key: ProviderRuntimeKey) {
  const definition = providerRuntimeDefinitions[key];
  const pin = definition.readPin();
  const versionRoot = providerRuntimeVersionRoot(dataRoot, key, pin.packageVersion);
  const installed = readInstalledProviderRuntime(versionRoot);
  if (!installed) throw new ProviderRuntimeMissingError(definition.label, pin.version);
  return { executable: path.join(versionRoot, installed.executable), version: installed.version };
}
