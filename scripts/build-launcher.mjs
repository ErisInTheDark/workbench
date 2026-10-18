/*
 * Exports:
 * - launcherSidecar: repository-owned agent `wb` launcher source and isolated build cache.
 * - buildLauncher: publish the Windows and Linux launcher images and manifest receipt.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineGoSidecar, publishSidecar, readGoOption } from "./native-sidecar-build.mjs";

export const launcherSidecar = defineGoSidecar({
  label: "launcher", source: "daemon/launcher", executable: "wb", protocol: 1,
});

export async function buildLauncher(executable) {
  await publishSidecar(launcherSidecar, executable);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildLauncher(readGoOption());
}
