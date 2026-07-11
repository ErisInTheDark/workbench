/*
 * Exports:
 * - WorkbenchAgentCliAdaptedResponse: semantic stdout, stderr, and exit status for one Workbench response. Keywords: workbench, cli, response, output.
 * - adaptWorkbenchAgentCliResponse: convert known server envelopes into command-oriented output. Keywords: workbench, cli, json, stdout, errors.
 */
import type { WorkbenchAgentCliRequest } from "./workbench-agent-cli-commands.ts";

export interface WorkbenchAgentCliAdaptedResponse {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export function adaptWorkbenchAgentCliResponse({
  httpOk,
  request,
  text,
}: {
  httpOk: boolean;
  request: WorkbenchAgentCliRequest;
  text: string;
}): WorkbenchAgentCliAdaptedResponse {
  const payload = parseRecord(text);
  if (!httpOk) {
    return failed(readError(payload) || text || "Workbench request failed.");
  }

  switch (request.responseKind) {
    case "thread-title":
      return succeeded(`Thread title set: ${readString(payload, "title") || "untitled"}`);
    case "checkpoint-create": {
      const action = readString(request.body, "action");
      const label = action === "diffCheckpoint" ? "Created diff checkpoint" : "Created checkpoint";
      return succeeded(`${label} ${readString(payload, "checkpointCommit") || "(unknown commit)"}`);
    }
    case "checkpoint-restore":
      return succeeded(`Restored checkpoint ${readString(payload, "checkpointCommit") || "(unknown commit)"}`);
    case "browse-command":
      return adaptBrowseCommand(payload, text);
    case "browse-session-control":
      return adaptBrowseSessionControl(request, payload);
    case "orchestrator-reload":
      return adaptOrchestratorReload(payload, text);
    case "collaboration-post-mutation":
      return adaptCollaborationPostMutation(request, payload);
    case "collaboration-memory-read":
      return raw(readString(payload, "memory"));
    case "collaboration-memory-write":
      return succeeded(readString(payload, "message") || "Collaboration memory updated.");
    case "json":
      return raw(formatJson(payload, text));
    case "native":
    default:
      return raw(text);
  }
}

function adaptBrowseCommand(payload: Record<string, unknown> | null, fallback: string): WorkbenchAgentCliAdaptedResponse {
  if (!payload) {
    return raw(fallback);
  }
  const ok = payload.ok === true;
  const stdout = readString(payload, "stdout");
  const stderr = readString(payload, "stderr");
  const error = readError(payload);
  const requestedExitCode = typeof payload.exitCode === "number" && Number.isFinite(payload.exitCode)
    ? Math.max(0, Math.trunc(payload.exitCode))
    : null;
  return {
    exitCode: ok ? requestedExitCode ?? 0 : requestedExitCode && requestedExitCode > 0 ? requestedExitCode : 1,
    stderr: joinOutput(error, stderr),
    stdout,
  };
}

function adaptBrowseSessionControl(
  request: WorkbenchAgentCliRequest,
  payload: Record<string, unknown> | null,
): WorkbenchAgentCliAdaptedResponse {
  const action = readString(request.body, "action");
  const session = readString(request.body, "session") || "(unknown session)";
  if (payload?.stopped !== true) {
    return succeeded(`Browse session ${session} was already stopped.`);
  }
  return succeeded(action === "forget" ? `Forgot Browse session ${session}` : `Stopped Browse session ${session}`);
}

function adaptOrchestratorReload(payload: Record<string, unknown> | null, fallback: string) {
  if (!payload) {
    return raw(fallback);
  }
  if (payload.state === "failed") {
    return failed(readError(payload) || "Orchestrator reload failed.");
  }
  const applied = readStringArray(payload, "appliedScopes");
  const queued = readStringArray(payload, "queuedScopes");
  return succeeded([
    "Reload succeeded.",
    `Applied: ${applied.length ? applied.join(", ") : "none"}`,
    `Queued: ${queued.length ? queued.join(", ") : "none"}`,
  ].join("\n"));
}

function adaptCollaborationPostMutation(
  request: WorkbenchAgentCliRequest,
  payload: Record<string, unknown> | null,
): WorkbenchAgentCliAdaptedResponse {
  const action = readString(request.body, "action");
  const postId = readString(payload, "postId") || readString(request.body, "postId");
  if (action === "delete") {
    return succeeded(`Deleted Collaboration post ${postId || "(unknown post)"}`);
  }
  const projected = {
    action: readString(payload, "action") || action,
    message: readString(payload, "message"),
    postId,
    ...(payload && isRecord(payload.post) ? { post: payload.post } : {}),
  };
  return raw(`${JSON.stringify(projected, null, 2)}\n`);
}

function readError(payload: Record<string, unknown> | null) {
  return readString(payload, "error") || readString(payload, "message");
}

function readString(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseRecord(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatJson(payload: Record<string, unknown> | null, fallback: string) {
  return payload ? `${JSON.stringify(payload, null, 2)}\n` : fallback;
}

function joinOutput(...values: string[]) {
  return values.filter(Boolean).map(ensureNewline).join("");
}

function ensureNewline(value: string) {
  return value && !value.endsWith("\n") ? `${value}\n` : value;
}

function raw(stdout = ""): WorkbenchAgentCliAdaptedResponse {
  return { exitCode: 0, stderr: "", stdout };
}

function succeeded(stdout: string): WorkbenchAgentCliAdaptedResponse {
  return { exitCode: 0, stderr: "", stdout: ensureNewline(stdout) };
}

function failed(stderr: string): WorkbenchAgentCliAdaptedResponse {
  return { exitCode: 1, stderr: ensureNewline(stderr), stdout: "" };
}
