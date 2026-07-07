/*
 * Exports:
 * - WorkbenchSidebarSectionId: stable ids for reorderable desktop sidebar content sections. Keywords: workbench, sidebar, layout.
 * - DEFAULT_WORKBENCH_SIDEBAR_SECTION_ORDER: default desktop sidebar section order. Keywords: sidebar, defaults.
 * - readStoredWorkbenchMainLayout/writeStoredWorkbenchMainLayout: project-scoped main split layout persistence. Keywords: localStorage, split layout.
 * - readStoredWorkbenchSidebarSectionOrder/writeStoredWorkbenchSidebarSectionOrder: sidebar section order persistence. Keywords: localStorage, sidebar order.
 */

import WorkbenchMainLayout, { type WorkbenchMainLayout as WorkbenchMainLayoutState, type WorkbenchPanelTarget } from "./workbench-layout";

const MAIN_LAYOUT_STORAGE_KEY = "workbench:main-layout:v1";
const SIDEBAR_ORDER_STORAGE_KEY = "workbench:sidebar-section-order:v1";

export type WorkbenchSidebarSectionId = "browseSessions" | "project" | "threads" | "files";

export const DEFAULT_WORKBENCH_SIDEBAR_SECTION_ORDER: readonly WorkbenchSidebarSectionId[] = [
  "project",
  "threads",
  "files",
  "browseSessions",
];

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

function normalizeSidebarSectionOrder(value: unknown): WorkbenchSidebarSectionId[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_WORKBENCH_SIDEBAR_SECTION_ORDER];
  }

  const knownIds = new Set(DEFAULT_WORKBENCH_SIDEBAR_SECTION_ORDER);
  const seen = new Set<WorkbenchSidebarSectionId>();
  const normalized: WorkbenchSidebarSectionId[] = [];
  for (const sectionId of value) {
    if (typeof sectionId !== "string" || !knownIds.has(sectionId as WorkbenchSidebarSectionId)) {
      continue;
    }

    const typedSectionId = sectionId as WorkbenchSidebarSectionId;
    if (seen.has(typedSectionId)) {
      continue;
    }

    seen.add(typedSectionId);
    normalized.push(typedSectionId);
  }

  for (const sectionId of DEFAULT_WORKBENCH_SIDEBAR_SECTION_ORDER) {
    if (!seen.has(sectionId)) {
      normalized.push(sectionId);
    }
  }

  return normalized;
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

export function readStoredWorkbenchSidebarSectionOrder(): WorkbenchSidebarSectionId[] {
  if (typeof window === "undefined") {
    return [...DEFAULT_WORKBENCH_SIDEBAR_SECTION_ORDER];
  }

  return normalizeSidebarSectionOrder(readJsonStorageValue(SIDEBAR_ORDER_STORAGE_KEY));
}

export function writeStoredWorkbenchSidebarSectionOrder(sectionOrder: readonly WorkbenchSidebarSectionId[]) {
  if (typeof window === "undefined") {
    return;
  }

  writeJsonStorageValue(SIDEBAR_ORDER_STORAGE_KEY, normalizeSidebarSectionOrder(sectionOrder));
}
