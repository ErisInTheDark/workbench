/*
 * Exports:
 * - relaySidecar: repository-owned Linux sandbox loopback relay source and isolated build cache.
 * - buildRelay: publish the Linux relay sidecar and manifest receipt.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineGoSidecar, publishSidecar, readGoOption } from "./native-sidecar-build.mjs";

export const relaySidecar = defineGoSidecar({
  label: "relay", source: "daemon/relay", executable: "workbench-relay", protocol: 1, platforms: ["linux-x64"],
});

export async function buildRelay(executable) {
  await publishSidecar(relaySidecar, executable);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRelay(readGoOption());
}
