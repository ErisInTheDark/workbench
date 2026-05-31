/*
 * Exports:
 * - formatSessionSource: flatten generated Codex session sources for sidebar display. Keywords: thread, source, sidebar.
 * - formatThreadStatus: flatten generated Codex thread statuses for workbench state comparisons. Keywords: thread, status, active.
 * - getCodexThreadCwdFilterPaths: build exact-match cwd filter variants for Codex app-server thread listing. Keywords: thread, cwd, filter, windows.
 * - isCodexThreadWithinRoot/isCodexThreadAtRoot: browser-safe absolute path checks for project thread filtering. Keywords: cwd, root, filter.
 * - isProjectCodexThread: test whether a generated Codex thread belongs to the current project root. Keywords: thread, cwd, project.
 * - toThreadSummary: normalize generated Codex threads for the explorer sidebar. Keywords: summary, thread list.
 * - toThreadPayload: normalize generated Codex threads for the thread detail view. Keywords: payload, turns, thread read.
 */
import type { ThreadPayload, ThreadSummary, WorkbenchHarness } from "../types";
import type { SessionSource } from "./generated/app-server/v2/SessionSource";
import type { Thread } from "./generated/app-server/v2/Thread";
import type { ThreadStatus } from "./generated/app-server/v2/ThreadStatus";
import type { ThreadTokenUsage } from "./generated/app-server/v2/ThreadTokenUsage";

function normalizeAbsolutePathForComparison(filePath: string) {
  const normalized = String(filePath ?? "")
    .trim()
    .replace(/^\\\\\?\\UNC\\/iu, "//")
    .replace(/^\\\\\?\\/iu, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");

  return /^[a-z]:/iu.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

function upperCaseWindowsDrive(filePath: string) {
  return filePath.replace(/^[a-z]:/iu, (drive) => drive.toUpperCase());
}

export function getCodexThreadCwdFilterPaths(rootPath: string) {
  const normalizedRootPath = normalizeAbsolutePathForComparison(rootPath);
  if (!normalizedRootPath) {
    return [];
  }

  const candidates = new Set<string>([
    String(rootPath ?? "").trim().replace(/\/+$/, ""),
    normalizedRootPath,
  ]);

  if (/^[a-z]:\//iu.test(normalizedRootPath)) {
    const backslashPath = normalizedRootPath.replace(/\//g, "\\");
    const upperDriveBackslashPath = upperCaseWindowsDrive(backslashPath);
    candidates.add(backslashPath);
    candidates.add(upperDriveBackslashPath);
    candidates.add(`\\\\?\\${backslashPath}`);
    candidates.add(`\\\\?\\${upperDriveBackslashPath}`);
  }

  return Array.from(candidates).filter(Boolean);
}

export function formatSessionSource(source: SessionSource) {
  if (typeof source === "string") {
    return source;
  }

  if ("custom" in source) {
    return `custom:${source.custom}`;
  }

  if (typeof source.subAgent === "string") {
    return `subAgent:${source.subAgent}`;
  }

  if ("thread_spawn" in source.subAgent) {
    const role = source.subAgent.thread_spawn.agent_role?.trim();
    const nickname = source.subAgent.thread_spawn.agent_nickname?.trim();
    return `subAgent:${role || nickname || "spawned"}`;
  }

  if ("other" in source.subAgent) {
    return `subAgent:${source.subAgent.other}`;
  }

  return "subAgent";
}

export function formatThreadStatus(status: ThreadStatus) {
  switch (status.type) {
    case "notLoaded":
      return "notLoaded";
    case "idle":
      return "idle";
    case "systemError":
      return "systemError";
    case "active":
      return status.activeFlags.length
        ? `active:${status.activeFlags.join(",")}`
        : "active";
  }

  const unhandledStatus: never = status;
  return unhandledStatus;
}

export function isCodexThreadWithinRoot(candidatePath: string, rootPath: string) {
  if (!candidatePath.trim() || !rootPath.trim()) {
    return false;
  }

  const normalizedCandidatePath = normalizeAbsolutePathForComparison(candidatePath);
  const normalizedRootPath = normalizeAbsolutePathForComparison(rootPath);
  return normalizedCandidatePath === normalizedRootPath
    || normalizedCandidatePath.startsWith(`${normalizedRootPath}/`);
}

export function isCodexThreadAtRoot(candidatePath: string, rootPath: string) {
  if (!candidatePath.trim() || !rootPath.trim()) {
    return false;
  }

  return normalizeAbsolutePathForComparison(candidatePath) === normalizeAbsolutePathForComparison(rootPath);
}

export function isProjectCodexThread(thread: Pick<Thread, "cwd">, rootPath: string) {
  return isCodexThreadAtRoot(thread.cwd, rootPath);
}

export function toThreadSummary(thread: Thread, harness: WorkbenchHarness = "codex"): ThreadSummary {
  return {
    id: thread.id,
    harness,
    name: thread.name,
    preview: thread.preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: formatThreadStatus(thread.status),
    cwd: thread.cwd,
    source: formatSessionSource(thread.source),
    path: thread.path,
    forkedFromId: thread.forkedFromId,
    agentNickname: thread.agentNickname,
    agentRole: thread.agentRole,
    unreadBadge: null,
  };
}

export function toThreadPayload(
  thread: Thread,
  harness: WorkbenchHarness = "codex",
  model: string | null = null,
  reasoningEffort: string | null = null,
  serviceTier: string | null = null,
  agentPath: string | null = null,
  tokenUsage: ThreadTokenUsage | null = null,
): ThreadPayload {
  return {
    ...toThreadSummary(thread, harness),
    model,
    reasoningEffort,
    serviceTier,
    agentPath,
    isDraft: false,
    tokenUsage,
    turns: thread.turns,
  };
}
