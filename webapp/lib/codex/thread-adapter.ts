/*
 * Exports:
 * - formatSessionSource: flatten generated Codex session sources for sidebar display. Keywords: thread, source, sidebar.
 * - formatThreadStatus: flatten generated Codex thread statuses for workbench state comparisons. Keywords: thread, status, active.
 * - isCodexThreadWithinRoot: browser-safe absolute path containment check for project thread filtering. Keywords: cwd, root, filter.
 * - isProjectCodexThread: test whether a generated Codex thread belongs to the current project. Keywords: thread, cwd, project.
 * - toThreadSummary: normalize generated Codex threads for the explorer sidebar. Keywords: summary, thread list.
 * - toThreadPayload: normalize generated Codex threads for the thread detail view. Keywords: payload, turns, thread read.
 */
import type { Thread } from "./generated/app-server/v2/Thread";
import type { ThreadStatus } from "./generated/app-server/v2/ThreadStatus";
import type { SessionSource } from "./generated/app-server/v2/SessionSource";
import type { ThreadPayload, ThreadSummary } from "../types";

function normalizeAbsolutePathForComparison(filePath: string) {
  const normalized = String(filePath ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");

  return /^[a-z]:/iu.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

export function formatSessionSource(source: SessionSource) {
  if (typeof source === "string") {
    return source;
  }

  if ("custom" in source) {
    return `custom:${source.custom}`;
  }

  return `subAgent:${source.subAgent}`;
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

export function isProjectCodexThread(thread: Pick<Thread, "cwd">, rootPath: string) {
  return isCodexThreadWithinRoot(thread.cwd, rootPath);
}

export function toThreadSummary(thread: Thread): ThreadSummary {
  return {
    id: thread.id,
    name: thread.name,
    preview: thread.preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: formatThreadStatus(thread.status),
    cwd: thread.cwd,
    source: formatSessionSource(thread.source),
    path: thread.path,
  };
}

export function toThreadPayload(thread: Thread): ThreadPayload {
  return {
    ...toThreadSummary(thread),
    turns: thread.turns,
  };
}
