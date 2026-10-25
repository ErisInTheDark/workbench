/*
 * Exports:
 * - readDaemonEndpoint: read a bounded validated publication, or absent state; owned by the dependency-free package.
 * - publishDaemonEndpoint: atomically publish a ready daemon's endpoint.
 * - removeDaemonEndpoint: withdraw only the caller's process instance.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readDaemonEndpoint } from "../../package/workbench-daemon.mjs";
import {
  WorkbenchDaemonEndpointSchema, type WorkbenchDaemonEndpoint,
} from "../http/workbench-daemon-endpoint.ts";

export { readDaemonEndpoint };

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function publishDaemonEndpoint(file: string, endpoint: WorkbenchDaemonEndpoint) {
  const encoded = JSON.stringify(WorkbenchDaemonEndpointSchema.parse(endpoint));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, encoded, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    try { await fs.unlink(temporary); }
    catch (cleanupError) {
      if (!missing(cleanupError)) throw new AggregateError([error, cleanupError], "Daemon publication and cleanup failed.");
    }
    throw error;
  }
}

export async function removeDaemonEndpoint(file: string, instanceId: string) {
  const current = await readDaemonEndpoint(file);
  if (current?.instanceId === instanceId) await fs.unlink(file);
}
