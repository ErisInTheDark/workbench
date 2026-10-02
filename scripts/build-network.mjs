/*
 * Exports:
 * - networkSidecar: repository-owned network source and isolated build cache.
 * - buildNetwork: publish the current platform's verified network sidecar and manifest.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentSidecarPlatform, defineGoSidecar, publishSidecar, readGoOption } from "./native-sidecar-build.mjs";

export const networkSidecar = defineGoSidecar({
  label: "network", source: "shared/network/native", executable: "workbench-network", protocol: 1,
});

export async function buildNetwork(executable) {
  const platform = currentSidecarPlatform();
  if (!platform) throw new Error("Network binary publication currently supports Windows x64 and Linux x64.");
  await publishSidecar(networkSidecar, platform, executable);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildNetwork(readGoOption());
}
