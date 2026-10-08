/*
 * Exports:
 * - repoSidecar: repository-owned virtual repository source and isolated build cache.
 * - buildRepo: publish every supported virtual repository sidecar and manifest receipt.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineGoSidecar, publishSidecar, readGoOption } from "./native-sidecar-build.mjs";

export const repoSidecar = defineGoSidecar({
  label: "repo", source: "daemon/repo", executable: "workbench-repo", protocol: 1,
});

export async function buildRepo(executable) {
  await publishSidecar(repoSidecar, executable);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRepo(readGoOption());
}
