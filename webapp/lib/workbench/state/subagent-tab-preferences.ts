/*
 * Exports:
 * - readStoredPinnedSubagentThreadIds: read ordered project-and-parent-scoped subagent tab pins from localStorage. Keywords: subagent, tabs, pinned, localStorage.
 * - writeStoredPinnedSubagentThreadIds: persist ordered project-and-parent-scoped subagent tab pins to localStorage. Keywords: subagent, tabs, pinned, persistence.
 */

const SUBAGENT_TAB_PINS_STORAGE_KEY = "workbench:subagent-tab-pins:v1";

function getStorageKey(projectId: string, parentThreadId: string) {
  return `${SUBAGENT_TAB_PINS_STORAGE_KEY}:${encodeURIComponent(projectId)}:${encodeURIComponent(parentThreadId)}`;
}

function normalizePinnedThreadIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((threadId): threadId is string => (
    typeof threadId === "string" && Boolean(threadId.trim()) && threadId.trim() === threadId
  ))));
}

export function readStoredPinnedSubagentThreadIds(projectId: string, parentThreadId: string) {
  if (typeof window === "undefined") return [];
  try {
    const rawValue = window.localStorage.getItem(getStorageKey(projectId, parentThreadId));
    return normalizePinnedThreadIds(rawValue ? JSON.parse(rawValue) as unknown : null);
  } catch {
    return [];
  }
}

export function writeStoredPinnedSubagentThreadIds(
  projectId: string,
  parentThreadId: string,
  pinnedThreadIds: readonly string[],
) {
  if (typeof window === "undefined") return;
  try {
    const normalizedThreadIds = normalizePinnedThreadIds(pinnedThreadIds);
    const storageKey = getStorageKey(projectId, parentThreadId);
    if (normalizedThreadIds.length) {
      window.localStorage.setItem(storageKey, JSON.stringify(normalizedThreadIds));
    } else {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // Tab pins are best-effort; the in-memory state remains authoritative.
  }
}
