/*
 * Exports:
 * - daemonGitArcIdentity: the invoking agent thread's Git arc identity, or null outside agent threads.
 * - readDaemonEndpoint: read the bounded, loopback-only local daemon publication, or null when none is published.
 * - requestDaemonGitArc: send one Git arc request as the invoking thread to the published local daemon.
 */
import fs from "node:fs/promises";
import path from "node:path";
import resolveWorkbenchDataRoot from "./workbench-data-root.mjs";

const ENDPOINT_SIZE_LIMIT = 16_384;
const ENDPOINT_KEYS = ["instanceId", "origin", "pid", "version"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function daemonGitArcIdentity(env = process.env) {
  const threadId = env.WORKBENCH_THREAD_ID || env.CODEX_THREAD_ID;
  return threadId ? { harness: env.WORKBENCH_HARNESS || "codex", threadId } : null;
}

function isLoopbackOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === value && url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0;
  } catch {
    return false;
  }
}

function isEndpoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).sort().join() === ENDPOINT_KEYS.join()
    && value.version === 1
    && typeof value.instanceId === "string" && UUID.test(value.instanceId)
    && Number.isInteger(value.pid) && value.pid >= 1
    && isLoopbackOrigin(value.origin);
}

export async function readDaemonEndpoint(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Local daemon endpoint could not be opened.", { cause: error });
  }
  try {
    const buffer = Buffer.alloc(ENDPOINT_SIZE_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size === buffer.length) throw new Error("Local daemon endpoint exceeds its size limit.");
    const parsed = JSON.parse(buffer.toString("utf8", 0, size));
    if (!isEndpoint(parsed)) throw new Error("Local daemon endpoint is invalid.");
    return parsed;
  } finally {
    await handle.close();
  }
}

export async function requestDaemonGitArc(request, { env = process.env, fetch = globalThis.fetch, signal } = {}) {
  const endpoint = await readDaemonEndpoint(path.join(resolveWorkbenchDataRoot({ environment: env }), "daemon", "runtime.json"));
  if (!endpoint) throw new Error("The Workbench daemon has not published an endpoint.");
  const response = await fetch(new URL("/daemon/git-arc", endpoint.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, ...daemonGitArcIdentity(env) }),
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error(`Git arc ${request.action} request failed (HTTP ${response.status}).`);
  return await response.json();
}
