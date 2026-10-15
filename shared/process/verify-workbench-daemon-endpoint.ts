/*
 * Exports:
 * - default verifyWorkbenchDaemonEndpoint: verify that a daemon publication still names its live process instance.
 */
import {
  WorkbenchDaemonEndpointSchema,
  type WorkbenchDaemonEndpoint,
} from "../http/workbench-daemon-endpoint.ts";
import { conformToZodSchema } from "../workbench/zod-schema-conformer.ts";

export default async function verifyWorkbenchDaemonEndpoint(
  endpoint: WorkbenchDaemonEndpoint,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const response = await fetcher(`${endpoint.origin}/healthz`, {
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Daemon health endpoint is unavailable.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new Error("Daemon health response exceeds its size limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let actual: WorkbenchDaemonEndpoint;
  try {
    const conformed = conformToZodSchema(
      WorkbenchDaemonEndpointSchema,
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      endpoint,
    );
    if (conformed.repairedPaths.length) {
      throw new Error(`repaired ${conformed.repairedPaths.slice(0, 5).join(", ")}`);
    }
    actual = conformed.data;
  } catch (error) {
    throw new Error("Daemon health response is invalid.", { cause: error });
  }
  if (actual.instanceId !== endpoint.instanceId || actual.pid !== endpoint.pid || actual.origin !== endpoint.origin) {
    throw new Error("Daemon health identity does not match its publication.");
  }
}
