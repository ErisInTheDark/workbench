/*
 * Exports:
 * - repoSidecar: repository-owned virtual repository source and isolated build cache.
 * - buildRepo: publish both CGO-free virtual repository sidecars and their manifest.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineGoSidecar, publishSidecar, readGoOption } from "./native-sidecar-build.mjs";

export const repoSidecar = defineGoSidecar({
  label: "repo", source: "daemon/repo", executable: "workbench-repo", protocol: 1,
});

export async function buildRepo(executable) {
  // cgofuse loads WinFsp dynamically and go-fuse is pure Go, so both targets build from any host.
  for (const platform of ["windows-x64", "linux-x64"]) {
    await publishSidecar(repoSidecar, platform, executable);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRepo(readGoOption());
}
