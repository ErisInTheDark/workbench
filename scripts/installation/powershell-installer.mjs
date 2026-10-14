/*
 * Exports:
 * - POWERSHELL_RELEASES: pinned official Windows archives and SHA-256 hashes by architecture.
 * - default installPowerShell: download, verify and expand one pinned portable PowerShell release.
 */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WORKBENCH_POWERSHELL_VERSION } from "../../shared/windows-powershell-runtime.mjs";

export const POWERSHELL_RELEASES = Object.freeze({
  x64: {
    version: WORKBENCH_POWERSHELL_VERSION,
    sha256: "02fe458be20493fbdf43f61ea20610b811ee6c738ab1676c61b9cfcd1a33c860",
  },
  arm64: {
    version: WORKBENCH_POWERSHELL_VERSION,
    sha256: "bbde9dda31d148415eccb5fbe1638e6400a144187b006e5b3fd8ec2f39d781be",
  },
});

export default async function installPowerShell({
  destination,
  directory,
  commands,
  onOutput,
  arch = process.arch,
  releases = POWERSHELL_RELEASES,
  fetchInstaller = fetch,
  files = fs,
}) {
  const release = releases[arch];
  if (!release) throw new Error(`Workbench PowerShell is not available for Windows ${arch}.`);
  const asset = `PowerShell-${release.version}-win-${arch}.zip`;
  const url = `https://github.com/PowerShell/PowerShell/releases/download/v${release.version}/${asset}`;
  const response = await fetchInstaller(url);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`PowerShell download failed (HTTP ${response.status}).`);
  }
  await files.mkdir(directory, { recursive: true });
  const archive = path.join(directory, `${path.basename(asset, ".zip")}-${randomUUID()}.zip`);
  const script = path.join(directory, `expand-powershell-${randomUUID()}.ps1`);
  let failure;
  try {
    const hash = createHash("sha256");
    const hashing = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), hashing, createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    const actual = hash.digest("hex");
    if (actual !== release.sha256) {
      throw new Error(`PowerShell download hash mismatch for ${asset}; expected ${release.sha256}, received ${actual}.`);
    }
    await files.mkdir(destination, { recursive: true });
    await files.writeFile(script, [
      "param([string]$Archive, [string]$Destination)",
      "$ErrorActionPreference = 'Stop'",
      "Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force",
      "",
    ].join("\n"), { flag: "wx", mode: 0o600 });
    onOutput?.(`Expanding Workbench PowerShell ${release.version} for Windows ${arch}\n`);
    await commands.run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, archive, destination,
    ], { cwd: directory, onOutput });
  } catch (error) {
    failure = error;
  }
  const cleanup = [];
  for (const file of [archive, script]) {
    try { await files.unlink(file); }
    catch (error) { if (error.code !== "ENOENT") cleanup.push(error); }
  }
  if (failure && cleanup.length) {
    throw new AggregateError([failure, ...cleanup], `PowerShell setup failed and temporary files could not be removed from ${directory}.`, { cause: failure });
  }
  if (failure) throw failure;
  if (cleanup.length) throw cleanup[0];
}
