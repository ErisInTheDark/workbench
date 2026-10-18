/* Exports: none. Protect provider runtime platform package selection and pinned runtime resolution. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import {
  ProviderRuntimeMissingError,
  captureProviderRuntimePins,
  providerRuntimeDefinitions,
  providerRuntimeVersionRoot,
  resolveProviderRuntime,
  type ProviderRuntimeTarget,
} from "./provider-runtimes";

const target = (platform: NodeJS.Platform, arch: string, musl = false): ProviderRuntimeTarget => ({ platform, arch, musl });

test("Claude Code installs the SDK platform package matching the daemon's platform and libc", () => {
  const { packages } = providerRuntimeDefinitions.claude;
  assert.deepEqual(packages(target("win32", "x64")), ["@anthropic-ai/claude-agent-sdk-win32-x64"]);
  assert.deepEqual(packages(target("linux", "x64")), ["@anthropic-ai/claude-agent-sdk-linux-x64"]);
  assert.deepEqual(packages(target("linux", "arm64", true)), ["@anthropic-ai/claude-agent-sdk-linux-arm64-musl"]);
  assert.deepEqual(packages(target("darwin", "arm64")), ["@anthropic-ai/claude-agent-sdk-darwin-arm64"]);
  assert.deepEqual(packages(target("freebsd", "x64")), []);
  assert.deepEqual(packages(target("linux", "ia32")), []);
});

test("OpenCode prefers the AVX2 build on x64 and keeps the baseline build as fallback", () => {
  const { packages } = providerRuntimeDefinitions.opencode;
  assert.deepEqual(packages(target("win32", "x64")), ["@opencode/cli-windows-x64", "@opencode/cli-windows-x64-baseline"]);
  assert.deepEqual(packages(target("linux", "x64", true)), ["@opencode/cli-linux-x64-musl", "@opencode/cli-linux-x64-baseline-musl"]);
  assert.deepEqual(packages(target("linux", "arm64")), ["@opencode/cli-linux-arm64"]);
  assert.deepEqual(packages(target("darwin", "x64")), ["@opencode/cli-darwin-x64", "@opencode/cli-darwin-x64-baseline"]);
  assert.deepEqual(packages(target("sunos", "x64")), []);
});

test("pins follow the checkout's installed SDK versions", () => {
  const pins = captureProviderRuntimePins();
  const claude = pins.claude();
  assert.match(claude.packageVersion, /^\d+\.\d+\.\d+/u);
  assert.match(claude.version, /^\d+\.\d+\.\d+/u);
  assert.notEqual(claude.packageVersion, claude.version);
  const opencode = pins.opencode();
  assert.equal(opencode.packageVersion, opencode.version);
});

test("only a committed runtime for the current pin resolves", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("provider-runtimes-");
  try {
    const dataRoot = temporary.path;
    const pin = { packageVersion: "2.0.0", version: "2.0.0" };
    assert.throws(() => resolveProviderRuntime(dataRoot, "opencode", pin), ProviderRuntimeMissingError);
    const versionRoot = providerRuntimeVersionRoot(dataRoot, "opencode", pin.packageVersion);
    const executable = path.join("node_modules", "@opencode", "cli-test", "bin", "opencode");
    const marker = { packageName: "@opencode/cli-test", packageVersion: pin.packageVersion, version: pin.version, executable };
    await mkdir(versionRoot, { recursive: true });
    await writeFile(path.join(versionRoot, "installed.json"), JSON.stringify(marker));
    // A marker whose executable vanished is not an installation.
    assert.throws(() => resolveProviderRuntime(dataRoot, "opencode", pin), ProviderRuntimeMissingError);
    await mkdir(path.dirname(path.join(versionRoot, executable)), { recursive: true });
    await writeFile(path.join(versionRoot, executable), "");
    assert.deepEqual(resolveProviderRuntime(dataRoot, "opencode", pin), { executable: path.join(versionRoot, executable), version: pin.version });

    const stale = providerRuntimeVersionRoot(dataRoot, "claude", "0.0.1");
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "claude"), "");
    await writeFile(path.join(stale, "installed.json"), JSON.stringify({ packageName: "x", packageVersion: "0.0.1", version: "1.0.0", executable: "claude" }));
    assert.throws(() => resolveProviderRuntime(dataRoot, "claude", { packageVersion: "0.0.2", version: "2.0.0" }), /Settings › Agents › Providers/u);
  } finally { await temporary.dispose(); }
});
