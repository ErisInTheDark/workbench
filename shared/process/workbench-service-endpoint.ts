/*
 * Exports:
 * - readServiceEndpoint: read a bounded private service publication.
 * - publishServiceEndpoint: atomically publish the authenticated control endpoint.
 * - removeServiceEndpoint: withdraw only the current process's publication.
 * - verifyServiceEndpoint: verify process identity without starting a daemon.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkbenchServiceEndpointSchema, type WorkbenchServiceEndpoint } from "../http/workbench-service.ts";
import { WorkbenchDaemonEndpointSchema } from "../http/workbench-daemon-endpoint.ts";

export async function readServiceEndpoint(file: string): Promise<WorkbenchServiceEndpoint | null> {
  let handle;
  try { handle = await fs.open(file, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Service endpoint could not be opened.", { cause: error });
  }
  try {
    const buffer = Buffer.alloc(16_385);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === buffer.length) throw new Error("Service endpoint exceeds its size limit.");
    const parsed = WorkbenchServiceEndpointSchema.safeParse(JSON.parse(buffer.toString("utf8", 0, size)));
    if (!parsed.success) throw new Error("Service endpoint publication is invalid.");
    return parsed.data;
  } finally {
    await handle.close();
  }
}

export async function publishServiceEndpoint(file: string, endpoint: WorkbenchServiceEndpoint) {
  const encoded = JSON.stringify(WorkbenchServiceEndpointSchema.parse(endpoint));
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, encoded, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    try { await fs.unlink(temporary); }
    catch (cleanup) {
      if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError([error, cleanup], "Service publication and cleanup failed.");
      }
    }
    throw error;
  }
}

export async function removeServiceEndpoint(file: string, instanceId: string) {
  const current = await readServiceEndpoint(file);
  if (current?.instanceId === instanceId) await fs.unlink(file);
}

export async function verifyServiceEndpoint(
  endpoint: WorkbenchServiceEndpoint, signal?: AbortSignal, fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`${endpoint.origin}/healthz`, {
    headers: { Authorization: `Bearer ${endpoint.token}` }, cache: "no-store", redirect: "error", signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Service health endpoint is unavailable.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new Error("Service health response exceeds its size limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const parsed = WorkbenchDaemonEndpointSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!parsed.success || parsed.data.instanceId !== endpoint.instanceId
    || parsed.data.pid !== endpoint.pid || parsed.data.origin !== endpoint.origin) {
    throw new Error("Service health identity does not match its publication.");
  }
}
