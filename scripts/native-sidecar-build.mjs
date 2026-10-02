/*
 * Exports:
 * - defineGoSidecar: describe one repository-owned Go sidecar and its isolated build cache.
 * - currentSidecarPlatform: map this host to a publishable artifact platform, or null.
 * - readGoOption: read the optional `--go <binary>` toolchain override.
 * - runSidecarGo: execute the selected Go toolchain inside a sidecar package with isolated caches.
 * - sidecarSourceHash: fingerprint production Go sources through the shared runtime verifier.
 * - publishSidecar: build, validate and atomically publish one platform artifact plus its manifest receipt.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { register } from "tsx/cjs/api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = Object.freeze({
  "windows-x64": { goos: "windows", extension: ".exe" },
  "linux-x64": { goos: "linux", extension: "" },
});

/**
 * @param {{ label: string, source: string, executable: string, protocol: number }} sidecar
 */
export function defineGoSidecar(sidecar) {
  return Object.freeze({
    ...sidecar,
    root,
    sourcePath: path.join(root, sidecar.source),
    cache: path.join(root, `.workbench/tmp/${sidecar.label}-build`),
  });
}

export function currentSidecarPlatform() {
  if (process.arch !== "x64" || !["win32", "linux"].includes(process.platform)) return null;
  return process.platform === "win32" ? "windows-x64" : "linux-x64";
}

export async function runSidecarGo(sidecar, args, executable = process.env.GO_BINARY || "go", environment = {}) {
  const temporary = path.join(sidecar.cache, "tmp");
  await fs.mkdir(temporary, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ["-C", sidecar.sourcePath, ...args], {
      cwd: root,
      windowsHide: true,
      stdio: "inherit",
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOTOOLCHAIN: "local",
        GOCACHE: path.join(sidecar.cache, "build"),
        GOMODCACHE: path.join(sidecar.cache, "modules"),
        TEMP: temporary,
        TMP: temporary,
        TMPDIR: temporary,
        ...environment,
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${capitalize(sidecar.label)} Go command failed (${signal || code}).`));
    });
  });
}

export async function sidecarSourceHash(sidecar) {
  const unregister = register();
  try {
    const require = createRequire(import.meta.url);
    const { nativeSidecarSourceHash } = require("../shared/native/native-sidecar-artifact.ts");
    return await nativeSidecarSourceHash(sidecar.sourcePath);
  } finally {
    unregister();
  }
}

/**
 * Cross-target builds must stay CGO-free; the caller owns which targets it may publish from this host.
 * @param {"windows-x64" | "linux-x64"} platform
 */
export async function publishSidecar(sidecar, platform, executable) {
  const target = targets[platform];
  const name = `${sidecar.executable}${target.extension}`;
  const label = capitalize(sidecar.label);
  await fs.mkdir(sidecar.cache, { recursive: true });
  const candidate = path.join(sidecar.cache, `candidate-${randomUUID()}${target.extension}`);
  const sourceHash = await sidecarSourceHash(sidecar);
  await runSidecarGo(
    sidecar,
    ["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", candidate, "."],
    executable,
    { GOOS: target.goos, GOARCH: "amd64" },
  );
  if (await sidecarSourceHash(sidecar) !== sourceHash) throw new Error(`${label} sources changed during compilation; no artifact was published.`);
  const bytes = await fs.readFile(candidate);
  if (target.goos === "windows") {
    const offset = bytes.readUInt32LE(0x3c);
    if (bytes.readUInt16LE(0) !== 0x5a4d || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) {
      throw new Error("Build did not produce a Windows x64 PE executable.");
    }
  } else if (bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes.readUInt16LE(18) !== 62) {
    throw new Error("Build did not produce a Linux x64 ELF executable.");
  }
  const destination = path.join(sidecar.sourcePath, "bin", platform, name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const manifestPath = path.join(sidecar.sourcePath, "bin/manifest.json");
  let manifest = { protocol: sidecar.protocol, artifacts: {} };
  try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  manifest.artifacts[platform] = {
    file: `${platform}/${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceHash,
  };
  const retired = path.join(sidecar.cache, `retired-${randomUUID()}-${name}`);
  const manifestCandidate = `${candidate}.manifest.json`;
  await fs.writeFile(manifestCandidate, `${JSON.stringify(manifest, null, 2)}\n`);
  let retiredPrevious = false;
  let publishedCandidate = false;
  try {
    try {
      await fs.rename(destination, retired);
      retiredPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.rename(candidate, destination);
    publishedCandidate = true;
    // A manifest is the publication receipt. Readers reject a mismatched pair
    // during this short transition rather than launching an unverified image.
    await fs.rename(manifestCandidate, manifestPath);
  } catch (publicationError) {
    const failures = [publicationError];
    let destinationAvailable = !publishedCandidate;
    if (publishedCandidate) {
      try { await fs.rename(destination, candidate); destinationAvailable = true; }
      catch (error) { failures.push(error); }
    }
    if (retiredPrevious && destinationAvailable) {
      try { await fs.rename(retired, destination); }
      catch (error) { failures.push(error); }
    }
    try { await fs.unlink(manifestCandidate); }
    catch (error) { if (error.code !== "ENOENT") failures.push(error); }
    if (failures.length > 1) throw new AggregateError(failures, `${label} publication failed and recovery was incomplete.`);
    throw publicationError;
  }
  if (retiredPrevious) {
    try { await fs.unlink(retired); }
    catch (error) {
      if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
      console.warn(`Retained running ${sidecar.label} image: ${retired}`);
    }
  }
  console.log(`Published ${platform} ${sidecar.label} sidecar (${bytes.length} bytes).`);
}

export function readGoOption(argv = process.argv) {
  const index = argv.indexOf("--go");
  return index < 0 ? undefined : argv[index + 1];
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
