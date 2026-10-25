/*
 * Exports:
 * - daemonGitArcIdentity: the invoking agent thread's Git arc identity, or null outside agent threads.
 * - requestDaemonGitArc: send one Git arc request as that thread to the published local daemon; returns its JSON body.
 * - DaemonGitArcRequestOptions: environment and fetch boundaries.
 */
import path from "node:path";
import { GitCheckpointRequestSchema, type GitCheckpointRequest } from "../shared/workbench/git/checkpoint-contracts";
import resolveWorkbenchDataRoot from "../shared/workbench-data-root";
import { readDaemonEndpoint } from "../shared/process/workbench-daemon-endpoint";

export interface DaemonGitArcRequestOptions {
  env: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}

type WithoutIdentity<Request> = Request extends unknown ? Omit<Request, "harness" | "threadId"> : never;

export function daemonGitArcIdentity(env: NodeJS.ProcessEnv) {
  const threadId = env.WORKBENCH_THREAD_ID ?? env.CODEX_THREAD_ID;
  return threadId ? { harness: env.WORKBENCH_HARNESS ?? "codex", threadId } : null;
}

export async function requestDaemonGitArc(request: WithoutIdentity<GitCheckpointRequest>, options: DaemonGitArcRequestOptions) {
  const endpoint = await readDaemonEndpoint(path.join(resolveWorkbenchDataRoot({ environment: options.env }), "daemon", "runtime.json"));
  if (!endpoint) throw new Error("The Workbench daemon has not published an endpoint.");
  const body = GitCheckpointRequestSchema.parse({ ...request, ...daemonGitArcIdentity(options.env) });
  const response = await (options.fetch ?? globalThis.fetch)(new URL("/daemon/git-arc", endpoint.origin), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Git arc ${request.action} request failed (HTTP ${response.status}).`);
  return await response.json();
}
