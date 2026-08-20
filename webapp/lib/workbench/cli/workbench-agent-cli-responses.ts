/*
 * Exports:
 * - WorkbenchAgentCliAdaptedResponse: semantic stdout, stderr, and exit status for one Workbench response. Keywords: workbench, cli, response, output.
 * - adaptWorkbenchAgentCliResponse: convert known server envelopes into command-oriented output. Keywords: workbench, cli, json, stdout, errors.
 */
import type { WorkbenchAgentCliRequest } from "./workbench-agent-cli-commands.ts";
import { renderSubagentListOutput, renderSubagentSettleOutput } from "../subagent/subagent-output";
import type { WorkbenchSubagentSummary } from "../../types";
import { formatGitArcReceipt, type GitArcAction } from "../git/git-arc-receipts";

export interface WorkbenchAgentCliAdaptedResponse {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function createArcReceipt(
  action: GitArcAction,
  payload: Record<string, unknown> | null,
  request: WorkbenchAgentCliRequest,
) {
  const ref = readString(payload, action === "propose" ? "sourceCheckpoint" : "checkpointCommit");
  if (!ref) return null;
  const selectedPaths = action === "propose"
    ? readStringArray(payload, "paths")
    : readStringArray(request.body ?? null, "paths");
  return formatGitArcReceipt({
    action,
    ...(action === "mv" ? {
      additionalClaims: readStringArray(payload, "additionalClaims"),
      matchedPathCount: readNumber(payload, "matchedPathCount"),
      mappings: readMappings(payload),
      mode: readString(payload, "mode") === "preview" ? "preview" as const : "applied" as const,
      remainingMatchCount: readNumber(payload, "remainingMatchCount"),
    } : {}),
    claimedPaths: readStringArray(payload, "scopePaths"),
    intentName: readString(payload, "intentName") || null,
    ...(action === "propose" && readString(payload, "proposalId")
      ? { proposalId: readString(payload, "proposalId") }
      : {}),
    ref,
    ...(selectedPaths.length ? { selectedPaths } : {}),
    version: 1,
  });
}

function appendArcReceipt(lines: string[], receipt: string | null) {
  return receipt ? [...lines, receipt] : lines;
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
    case "thread-title-get":
      return succeeded(`Thread title: ${readString(payload, "title") || "untitled"}`);
    case "thread-title":
      return succeeded(`Thread title set: ${readString(payload, "title") || "untitled"}`);
    case "thread-status":
      return succeeded(`Thread status set: ${readString(payload, "agentStatus") || "unknown"}`);
    case "subagent-create":
      return succeeded(readString(payload, "threadId") || "");
    case "subagent-list": {
      const subagents = Array.isArray(payload?.subagents) ? payload.subagents.filter(isRecord) as unknown as WorkbenchSubagentSummary[] : [];
      return succeeded(renderSubagentListOutput(subagents, request.body?.settled === true, readString(payload, "nextCursor") || null));
    }
    case "subagent-settle": {
      const settled = Array.isArray(payload?.settled) ? payload.settled.filter(isRecord).flatMap((entry) => {
        const name = readString(entry, "name");
        const threadId = readString(entry, "threadId");
        return name && threadId ? [{ name, threadId }] : [];
      }) : [];
      return succeeded(renderSubagentSettleOutput(settled));
    }
    case "git-arc-plan":
    case "git-arc-add":
    case "git-arc-adopt":
    case "git-arc-continue":
    case "git-arc-remove": {
      const action = request.responseKind === "git-arc-plan"
        ? "plan"
        : request.responseKind === "git-arc-add"
          ? "add"
          : request.responseKind === "git-arc-adopt"
            ? "adopt"
          : request.responseKind === "git-arc-continue" ? "continue" : "remove";
      const label = action === "plan"
        ? request.body?.action === "planAdd" ? "Extended Git plan"
          : request.body?.action === "planRemove" ? "Reduced Git plan"
            : request.body?.action === "planAdopt" ? "Adopted changes into Git plan"
              : "Created Git plan"
        : action === "adopt" ? "Adopted workspace changes"
        : action === "continue" ? "Continued Git arc" : "Created successor arc ref";
      return succeeded(appendArcReceipt([
        `${label} ${readString(payload, "checkpointCommit") || "(unknown commit)"}`,
      ], createArcReceipt(action, payload, request)).join("\n"));
    }
    case "git-arc-start":
    case "git-arc-compare": {
      const action = request.responseKind === "git-arc-start" ? "start" : "compare";
      const changes = Array.isArray(payload?.changes) ? payload.changes.filter(isRecord) : [];
      const releasedClaims = readStringArray(payload, "releasedClaims");
      const acquiredClaims = readStringArray(payload, "acquiredClaims");
      return succeeded(appendArcReceipt([
        "Workbench arc comparison",
        ...(action === "start" ? [
          `Released claims: ${releasedClaims.length ? releasedClaims.join(", ") : "none"}`,
          `Acquired claims: ${acquiredClaims.length ? acquiredClaims.join(", ") : "none"}`,
        ] : []),
        ...changes.map((change) => {
          const kind = isRecord(change.kind) ? readString(change.kind, "type").slice(0, 1).toUpperCase() : "M";
          const additions = typeof change.additions === "number" ? change.additions : 0;
          const deletions = typeof change.deletions === "number" ? change.deletions : 0;
          return `${kind || "M"}\t+${additions}\t-${deletions}\t${readString(change, "path")}`;
        }),
      ], createArcReceipt(action, payload, request)).join("\n"));
    }
    case "git-arc-mv": {
      const mappings = readMappings(payload);
      const additionalClaims = readStringArray(payload, "additionalClaims");
      const matchedPathCount = readNumber(payload, "matchedPathCount") ?? mappings.length;
      const remainingMatchCount = readNumber(payload, "remainingMatchCount") ?? 0;
      const preview = readString(payload, "mode") === "preview";
      const lines = preview
        ? [
          "This command will rename the following files:",
          ...mappings.map(({ destination, source }) => `${source} -> ${destination}`),
          ...(remainingMatchCount > 0 ? [
            `${mappings.length} of ${matchedPathCount} matching paths are included in this batch. ${remainingMatchCount} matching paths remain.`,
          ] : []),
          ...(additionalClaims.length ? ["This command will additionally claim:", ...additionalClaims] : []),
          "Use the command again with --confirm to complete this batch if it looks correct."
            + (remainingMatchCount > 0 ? " Then preview again to map the remaining paths." : ""),
        ]
        : [
          `Moved ${mappings.length} ${mappings.length === 1 ? "path" : "paths"}.`,
          ...mappings.map(({ destination, source }) => `${source} -> ${destination}`),
          ...(remainingMatchCount > 0 ? [
            `${remainingMatchCount} matching paths remained when this batch ran. Preview again for the next batch.`,
          ] : []),
          ...(additionalClaims.length ? ["Additionally claimed:", ...additionalClaims] : []),
        ];
      return succeeded(appendArcReceipt(lines, createArcReceipt("mv", payload, request)).join("\n"));
    }
    case "git-arc-diff":
      return succeeded(appendArcReceipt([
        readString(payload, "diff"),
      ].filter(Boolean), createArcReceipt("diff", payload, request)).join("\n"));
    case "git-arc-propose": {
      const proposalId = readString(payload, "proposalId");
      const rescinded = request.body?.action === "proposalRescind";
      return succeeded(appendArcReceipt([
        rescinded
          ? `Rescinded arc proposal: ${proposalId || "(unknown proposal)"}`
          : `Workbench arc proposal: ${proposalId || "(unknown proposal)"}`,
      ], createArcReceipt("propose", payload, request)).join("\n"));
    }
    case "git-arc-restore": {
      const checkpointCommit = readString(payload, "checkpointCommit") || "(unknown commit)";
      const receipt = createArcReceipt("restore", payload, request);
      if (!Array.isArray(request.body?.paths)) {
        return succeeded(appendArcReceipt([`Restored arc ${checkpointCommit}`], receipt).join("\n"));
      }

      const restoredPaths = readStringArray(payload, "restoredPaths");
      if (!restoredPaths.length) {
        return succeeded(appendArcReceipt([`Selected paths already matched arc ${checkpointCommit}`], receipt).join("\n"));
      }
      return succeeded(appendArcReceipt([
        `Restored ${restoredPaths.length} ${restoredPaths.length === 1 ? "path" : "paths"} from arc ${checkpointCommit}:`,
        ...restoredPaths,
      ], receipt).join("\n"));
    }
    case "browse-command":
      return adaptBrowseCommand(payload, text);
    case "browse-session-control":
      return adaptBrowseSessionControl(request, payload);
    case "orchestrator-reload":
      return adaptOrchestratorReload(payload, text);
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

function readError(payload: Record<string, unknown> | null) {
  return readString(payload, "error") || readString(payload, "message");
}

function readString(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readStringArray(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readNumber(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

function readMappings(record: Record<string, unknown> | null | undefined) {
  const value = record?.mappings;
  if (!Array.isArray(value)) return [];
  return value.flatMap((mapping) => {
    if (!isRecord(mapping)) return [];
    const source = readString(mapping, "source");
    const destination = readString(mapping, "destination");
    return source && destination ? [{ destination, source }] : [];
  });
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
