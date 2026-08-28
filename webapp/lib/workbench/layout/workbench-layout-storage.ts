/*
 * Exports:
 * - readStoredWorkbenchMainLayout/writeStoredWorkbenchMainLayout: project-scoped main split layout persistence. Keywords: localStorage, split layout.
 */

import WorkbenchMainLayout, { type WorkbenchMainLayout as WorkbenchMainLayoutState, type WorkbenchPanelTarget } from "./workbench-layout";

const MAIN_LAYOUT_STORAGE_KEY = "workbench:main-layout:v1";

function getProjectStorageKey(baseKey: string, projectId: string) {
  return projectId ? `${baseKey}:${projectId}` : baseKey;
}

function readJsonStorageValue(key: string) {
  try {
    const rawValue = window.localStorage.getItem(key);
    return rawValue ? JSON.parse(rawValue) as unknown : null;
  } catch {
    return null;
  }
}

function writeJsonStorageValue(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Layout persistence is best-effort; the in-memory layout remains authoritative.
  }
}

export function readStoredWorkbenchMainLayout(projectId: string, fallbackTarget: WorkbenchPanelTarget): WorkbenchMainLayoutState {
  if (typeof window === "undefined") {
    return WorkbenchMainLayout.fromTarget(fallbackTarget);
  }

  return WorkbenchMainLayout.normalize(
    readJsonStorageValue(getProjectStorageKey(MAIN_LAYOUT_STORAGE_KEY, projectId)),
    fallbackTarget,
  );
}

export function writeStoredWorkbenchMainLayout(projectId: string, layout: WorkbenchMainLayoutState) {
  if (typeof window === "undefined") {
    return;
  }

  writeJsonStorageValue(getProjectStorageKey(MAIN_LAYOUT_STORAGE_KEY, projectId), layout);
}
