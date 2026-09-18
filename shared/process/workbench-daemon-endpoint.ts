/*
 * Exports:
 * - readDaemonEndpoint: read a bounded validated publication, or absent state.
 * - publishDaemonEndpoint: atomically publish a ready daemon's endpoint.
 * - removeDaemonEndpoint: withdraw only the caller's process instance.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  WorkbenchDaemonEndpointSchema, type WorkbenchDaemonEndpoint,
} from "../http/workbench-daemon-endpoint.ts";

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readDaemonEndpoint(file: string): Promise<WorkbenchDaemonEndpoint | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try { handle = await fs.open(file, "r"); }
  catch (error) {
    if (missing(error)) return null;
    throw new Error("Local daemon endpoint could not be opened.", { cause: error });
  }
  try {
    const buffer = Buffer.alloc(16_385);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === buffer.length) throw new Error("Local daemon endpoint exceeds its size limit.");
    const parsed = WorkbenchDaemonEndpointSchema.safeParse(JSON.parse(buffer.toString("utf8", 0, size)));
    if (!parsed.success) throw new Error("Local daemon endpoint is invalid.");
    return parsed.data;
  } finally {
    await handle.close();
  }
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
