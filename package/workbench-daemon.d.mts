/*
 * Exports:
 * - WorkbenchDaemonEndpoint: validated loopback publication of the running local daemon.
 * - DaemonGitArcIdentity: harness and thread a Git arc request acts as.
 * - DaemonGitArcRequest: one Git arc action body, without identity.
 * - DaemonGitArcRequestOptions: environment, fetch and cancellation boundaries.
 * - daemonGitArcIdentity: the invoking agent thread's Git arc identity, or null outside agent threads.
 * - readDaemonEndpoint: read the bounded, loopback-only local daemon publication, or null when none is published.
 * - requestDaemonGitArc: send one Git arc request as the invoking thread; resolves the raw JSON body for the caller to conform.
 */
export interface WorkbenchDaemonEndpoint {
  version: 1;
  instanceId: string;
  pid: number;
  origin: string;
}

export interface DaemonGitArcIdentity {
  harness: string;
  threadId: string;
}

export interface DaemonGitArcRequest {
  action: string;
  cwd: string;
  [field: string]: unknown;
}

export interface DaemonGitArcRequestOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export function daemonGitArcIdentity(env?: NodeJS.ProcessEnv): DaemonGitArcIdentity | null;
/** Rejects oversized, malformed or non-loopback publications so they never become a daemon address. */
export function readDaemonEndpoint(file: string): Promise<WorkbenchDaemonEndpoint | null>;
export function requestDaemonGitArc(request: DaemonGitArcRequest, options?: DaemonGitArcRequestOptions): Promise<unknown>;
