/*
 * Exports:
 * - networkSidecar: repository-owned network source and isolated build cache.
 * - buildNetwork: publish every supported network sidecar and manifest receipt.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineGoSidecar, publishSidecar, readGoOption } from "./native-sidecar-build.mjs";

export const networkSidecar = defineGoSidecar({
  label: "network", source: "shared/network/native", executable: "workbench-network", protocol: 1,
});

export async function buildNetwork(executable) {
  await publishSidecar(networkSidecar, executable);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildNetwork(readGoOption());
}
