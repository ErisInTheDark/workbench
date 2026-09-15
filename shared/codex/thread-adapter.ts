/*
 * Exports:
 * - formatSessionSource: flatten generated session sources for sidebar display.
 * - formatThreadStatus: flatten generated statuses for state comparisons.
 * - getCodexThreadCwdFilterPaths/getCodexThreadCwdFilterPathsForRoots: build exact-match cwd filter variants.
 * - isCodexThreadWithinRoot/isCodexThreadAtRoot: browser-safe absolute path checks.
 * - isProjectCodexThread: test project membership.
 * - isProjectCodexThreadAtExpectedCwd: validate relationship-owned descendant cwd.
 * - toThreadSummary: normalise sidebar metadata without changing identity provenance.
 * - toThreadPayload: normalise thread details without changing identity provenance.
 * - toThreadResumePayload: normalise resume metadata and its initial turn page.
 * - toThreadTurn: admit native item identity evidence before a turn reaches Workbench consumers.
 * - readWorkbenchTurnHistory: normalise the existing provider-thread history extension at its boundary.
 */
import type { ThreadPayloadData, ThreadSummary, WorkbenchHarness, WorkbenchThreadTurnHistoryEntry } from "../types.ts";
import type { SessionSource } from "./generated/app-server/v2/SessionSource.ts";
import type { Thread } from "./generated/app-server/v2/Thread.ts";
import type { ThreadResumeResponse } from "./generated/app-server/v2/ThreadResumeResponse.ts";
import type { ThreadStatus } from "./generated/app-server/v2/ThreadStatus.ts";
import type { ThreadTokenUsage } from "./generated/app-server/v2/ThreadTokenUsage.ts";
import type { Turn } from "../workbench/thread/workbench-thread-turn.ts";
import { normalizeWorkbenchThreadItemTimeline } from "../workbench/thread/thread-item-timeline.ts";
import { withCodexItemMetadata } from "./thread-item-source.ts";

type CompatibleThread = Omit<Thread, "turns"> & { turns: Turn[] };
type ThreadResumePayloadSource = Pick<ThreadResumeResponse, "thread">
  & Partial<Pick<ThreadResumeResponse, "initialTurnsPage" | "model" | "reasoningEffort" | "serviceTier">>;

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

export function getCodexThreadCwdFilterPathsForRoots(rootPaths: string[]) {
  return Array.from(new Set(rootPaths.flatMap((rootPath) => getCodexThreadCwdFilterPaths(rootPath))));
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

export function isProjectCodexThread(thread: Pick<Thread, "cwd">, rootPath: string | string[]) {
  const rootPaths = Array.isArray(rootPath) ? rootPath : [rootPath];
  return rootPaths.some((candidateRootPath) => isCodexThreadAtRoot(thread.cwd, candidateRootPath));
}

export function isProjectCodexThreadAtExpectedCwd(
  thread: Pick<Thread, "cwd">,
  rootPath: string | string[],
  expectedCwd: string | null | undefined,
) {
  if (!expectedCwd?.trim()) {
    return isProjectCodexThread(thread, rootPath);
  }

  const rootPaths = Array.isArray(rootPath) ? rootPath : [rootPath];
  return rootPaths.some((candidateRootPath) => isCodexThreadWithinRoot(expectedCwd, candidateRootPath))
    && isCodexThreadAtRoot(thread.cwd, expectedCwd);
}

export function toThreadSummary<Id extends string>(thread: Omit<CompatibleThread, "id"> & { id: Id }, harness: WorkbenchHarness = "codex"): ThreadSummary<Id> {
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
    agentNickname: thread.agentNickname,
    agentRole: thread.agentRole,
  };
}

export function toThreadTurn<T extends Turn>(turn: T, harness: WorkbenchHarness = "codex"): T {
  return harness === "codex" ? {
    ...turn,
    items: turn.items.map(withCodexItemMetadata),
  } : turn;
}

export function toThreadPayload<Id extends string>(
  thread: Omit<CompatibleThread, "id"> & { id: Id },
  harness: WorkbenchHarness = "codex",
  model: string | null = null,
  reasoningEffort: string | null = null,
  serviceTier: string | null = null,
  agentPath: string | null = null,
  tokenUsage: ThreadTokenUsage | null = null,
  nextPageCursor: string | null | undefined = undefined,
): ThreadPayloadData<Id> & { isDraft: false } {
  return {
    ...toThreadSummary(thread, harness),
    model,
    reasoningEffort,
    serviceTier,
    agentPath,
    isDraft: false,
    ...(nextPageCursor !== undefined ? { nextPageCursor } : {}),
    tokenUsage,
    turnHistory: readWorkbenchTurnHistory(thread) ?? createTurnHistoryFromTurns(thread.turns),
    turns: thread.turns.map((turn) => toThreadTurn(turn, harness)),
  };
}

export function toThreadResumePayload<Id extends string>(
  response: Omit<ThreadResumePayloadSource, "thread"> & { thread: Omit<Thread, "id"> & { id: Id } },
  harness: WorkbenchHarness = "codex",
  model: string | null = response.model ?? null,
  reasoningEffort: string | null = response.reasoningEffort ?? null,
  serviceTier: string | null = response.serviceTier ?? null,
  agentPath: string | null = null,
): ThreadPayloadData<Id> & { isDraft: false } {
  const thread = response.initialTurnsPage
    ? { ...response.thread, turns: response.initialTurnsPage.data }
    : response.thread;
  return toThreadPayload(thread, harness, model, reasoningEffort, serviceTier, agentPath);
}

function createTurnHistoryFromTurns(turns: Turn[]): WorkbenchThreadTurnHistoryEntry[] {
  return turns.map((turn) => ({
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    itemCount: turn.items.length,
    ...(turn.itemsView === "notLoaded" ? {} : { itemIds: turn.items.map((item) => item.id) }),
    loadState: turn.itemsView === "notLoaded" ? "unloaded" : "loaded",
    startedAt: turn.startedAt,
    status: turn.status,
    turnId: turn.id,
  }));
}

export function readWorkbenchTurnHistory(thread: CompatibleThread) {
  const value = (thread as CompatibleThread & { workbenchTurnHistory?: unknown }).workbenchTurnHistory;
  return Array.isArray(value)
    ? value
      .map(normalizeWorkbenchThreadTurnHistoryEntry)
      .filter((entry): entry is WorkbenchThreadTurnHistoryEntry => Boolean(entry))
    : null;
}

function asNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function normalizeWorkbenchThreadTurnHistoryEntry(value: unknown): WorkbenchThreadTurnHistoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.turnId !== "string"
    || typeof record.itemCount !== "number"
    || !Number.isFinite(record.itemCount)
    || (record.loadState !== "loaded" && record.loadState !== "missing" && record.loadState !== "unloaded")
  ) {
    return null;
  }

  const itemIds = normalizeStringArray(record.itemIds);
  const itemTimeline = normalizeWorkbenchThreadItemTimeline(record.itemTimeline);
  return {
    completedAt: asNullableNumber(record.completedAt),
    durationMs: asNullableNumber(record.durationMs),
    itemCount: record.itemCount,
    ...(itemIds ? { itemIds } : {}),
    ...(itemTimeline.length ? { itemTimeline } : {}),
    loadState: record.loadState,
    startedAt: asNullableNumber(record.startedAt),
    status: typeof record.status === "string" ? record.status as WorkbenchThreadTurnHistoryEntry["status"] : null,
    turnId: record.turnId,
  };
}
