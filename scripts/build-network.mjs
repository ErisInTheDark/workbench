/*
 * Exports:
 * - networkPaths: repository-owned network source and temporary build locations.
 * - runNetworkGo: execute the selected Go toolchain with isolated caches.
 * - networkSourceHash: fingerprint production Go sources and module identities.
 * - buildNetwork: publish the current platform's verified sidecar and manifest.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { register } from "tsx/cjs/api";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
export const networkPaths = Object.freeze({
  root,
  source: path.join(root, "app/network"),
  cache: path.join(root, ".workbench/tmp/network-build"),
});

export async function runNetworkGo(args, executable = process.env.GO_BINARY || "go", environment = {}) {
  const temporary = path.join(networkPaths.cache, "tmp");
  await fs.mkdir(temporary, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ["-C", networkPaths.source, ...args], {
      cwd: root,
      windowsHide: true,
      stdio: "inherit",
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOTOOLCHAIN: "local",
        GOCACHE: path.join(networkPaths.cache, "build"),
        GOMODCACHE: path.join(networkPaths.cache, "modules"),
        TEMP: temporary,
        TMP: temporary,
        TMPDIR: temporary,
        ...environment,
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Network Go command failed (${signal || code}).`));
    });
  });
}

export async function networkSourceHash() {
  const unregister = register();
  try {
    const require = createRequire(import.meta.url);
    const Process = require("../app/server/network/WorkbenchNetworkProcess.ts").default;
    return await Process.sourceHash(networkPaths.source);
  } finally {
    unregister();
  }
}

export async function buildNetwork(executable) {
  if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform)) {
    throw new Error("Network binary publication currently supports Windows x64 and Linux x64.");
  }
  const platform = process.platform === "win32" ? "windows-x64" : "linux-x64";
  const name = process.platform === "win32" ? "workbench-network.exe" : "workbench-network";
  const candidate = path.join(networkPaths.cache, `candidate-${randomUUID()}${process.platform === "win32" ? ".exe" : ""}`);
  const sourceHash = await networkSourceHash();
  await runNetworkGo(["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", candidate, "."], executable);
  if (await networkSourceHash() !== sourceHash) throw new Error("Network sources changed during compilation; no artifact was published.");
  const bytes = await fs.readFile(candidate);
  if (process.platform === "win32") {
    const offset = bytes.readUInt32LE(0x3c);
    if (bytes.readUInt16LE(0) !== 0x5a4d || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) {
      throw new Error("Build did not produce a Windows x64 PE executable.");
    }
  } else if (bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes.readUInt16LE(18) !== 62) {
    throw new Error("Build did not produce a Linux x64 ELF executable.");
  }
  const destination = path.join(networkPaths.source, "bin", platform, name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes, { mode: 0o755 });
  const manifestPath = path.join(networkPaths.source, "bin/manifest.json");
  let manifest = { protocol: 1, artifacts: {} };
  try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  manifest.artifacts[platform] = {
    file: `${platform}/${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceHash,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.unlink(candidate);
  console.log(`Published ${platform} network sidecar (${bytes.length} bytes).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const index = process.argv.indexOf("--go");
  await buildNetwork(index < 0 ? undefined : process.argv[index + 1]);
}
