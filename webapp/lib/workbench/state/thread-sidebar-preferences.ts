/*
 * Exports:
 * - WorkbenchThreadSidebarPreferences: persisted per-project sidebar thread metadata. Keywords: thread, sidebar, pinned, archived.
 * - EMPTY_WORKBENCH_THREAD_SIDEBAR_PREFERENCES: empty normalized sidebar preference value. Keywords: thread, sidebar, defaults.
 * - createWorkbenchThreadPreferenceKey: create a harness-qualified thread preference key. Keywords: thread, sidebar, key.
 * - areWorkbenchThreadSidebarPreferencesEqual: compare normalized sidebar preferences. Keywords: thread, sidebar, equality.
 * - normalizeWorkbenchThreadSidebarPreferences: validate and normalize unknown persisted sidebar preferences. Keywords: thread, sidebar, normalize.
 * - readStoredWorkbenchThreadSidebarPreferences: read project sidebar preferences from localStorage. Keywords: thread, sidebar, localStorage.
 * - writeStoredWorkbenchThreadSidebarPreferences: persist project sidebar preferences to localStorage. Keywords: thread, sidebar, localStorage.
 */

import type { ThreadSummary } from "../../types";

const THREAD_SIDEBAR_PREFERENCES_STORAGE_KEY = "workbench:thread-sidebar-preferences:v1";

export interface WorkbenchThreadSidebarPreferences {
  archivedThreadKeys: string[];
  pinnedThreadKeys: string[];
}

export const EMPTY_WORKBENCH_THREAD_SIDEBAR_PREFERENCES: WorkbenchThreadSidebarPreferences = {
  archivedThreadKeys: [],
  pinnedThreadKeys: [],
};

function getProjectStorageKey(projectId: string) {
  return projectId ? `${THREAD_SIDEBAR_PREFERENCES_STORAGE_KEY}:${projectId}` : THREAD_SIDEBAR_PREFERENCES_STORAGE_KEY;
}

function normalizeThreadKeys(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.filter((threadKey): threadKey is string => (
    typeof threadKey === "string" && threadKey.includes(":") && threadKey.trim() === threadKey
  )))).sort((left, right) => left.localeCompare(right));
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function createWorkbenchThreadPreferenceKey(thread: Pick<ThreadSummary, "harness" | "id">) {
  return `${thread.harness}:${thread.id}`;
}

export function areWorkbenchThreadSidebarPreferencesEqual(
  left: WorkbenchThreadSidebarPreferences,
  right: WorkbenchThreadSidebarPreferences,
) {
  return areStringArraysEqual(left.archivedThreadKeys, right.archivedThreadKeys)
    && areStringArraysEqual(left.pinnedThreadKeys, right.pinnedThreadKeys);
}

export function normalizeWorkbenchThreadSidebarPreferences(value: unknown): WorkbenchThreadSidebarPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_WORKBENCH_THREAD_SIDEBAR_PREFERENCES;
  }

  const candidate = value as Partial<WorkbenchThreadSidebarPreferences>;
  const archivedThreadKeys = normalizeThreadKeys(candidate.archivedThreadKeys);
  const pinnedThreadKeys = normalizeThreadKeys(candidate.pinnedThreadKeys)
    .filter((threadKey) => !archivedThreadKeys.includes(threadKey));

  return {
    archivedThreadKeys,
    pinnedThreadKeys,
  };
}

export function readStoredWorkbenchThreadSidebarPreferences(projectId: string) {
  if (typeof window === "undefined") {
    return EMPTY_WORKBENCH_THREAD_SIDEBAR_PREFERENCES;
  }

  try {
    const rawValue = window.localStorage.getItem(getProjectStorageKey(projectId));
    return normalizeWorkbenchThreadSidebarPreferences(rawValue ? JSON.parse(rawValue) as unknown : null);
  } catch {
    return EMPTY_WORKBENCH_THREAD_SIDEBAR_PREFERENCES;
  }
}

export function writeStoredWorkbenchThreadSidebarPreferences(
  projectId: string,
  preferences: WorkbenchThreadSidebarPreferences,
) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      getProjectStorageKey(projectId),
      JSON.stringify(normalizeWorkbenchThreadSidebarPreferences(preferences)),
    );
  } catch {
    // Sidebar preferences are best-effort; the in-memory state remains authoritative.
  }
}
