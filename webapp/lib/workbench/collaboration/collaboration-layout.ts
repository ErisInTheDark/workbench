/*
 * Exports:
 * - createDefaultWorkbenchCollaborationLayout: build the default two-pane Collaboration split layout. Keywords: collaboration, layout, scratchpad, collaborator.
 * - readStoredWorkbenchCollaborationLayout/writeStoredWorkbenchCollaborationLayout: persist project-scoped Collaboration pane sizing. Keywords: localStorage, split, resize.
 */

import WorkbenchMainLayout, {
  type WorkbenchMainLayout as WorkbenchMainLayoutState,
  type WorkbenchMainLayoutNode,
  type WorkbenchPanelTarget,
} from "../layout/workbench-layout";

const COLLABORATION_LAYOUT_STORAGE_KEY = "workbench:collaboration-layout:v1";
const COLLABORATION_SPLIT_ID = "collaboration-root";
const COLLABORATION_SCRATCHPAD_PANEL_ID = "collaboration-scratchpad";
const COLLABORATION_COLLABORATOR_PANEL_ID = "collaboration-collaborator";

export function createDefaultWorkbenchCollaborationLayout(): WorkbenchMainLayoutState {
  return {
    focusedPanelId: COLLABORATION_SCRATCHPAD_PANEL_ID,
    root: {
      direction: "horizontal",
      first: {
        id: COLLABORATION_SCRATCHPAD_PANEL_ID,
        target: { kind: "collaborationScratchpad" },
        type: "leaf",
      },
      firstFr: 52.5,
      id: COLLABORATION_SPLIT_ID,
      second: {
        id: COLLABORATION_COLLABORATOR_PANEL_ID,
        target: { kind: "collaborationCollaborator" },
        type: "leaf",
      },
      secondFr: 47.5,
      type: "split",
    },
  };
}

function getProjectStorageKey(projectId: string) {
  return projectId ? `${COLLABORATION_LAYOUT_STORAGE_KEY}:${projectId}` : COLLABORATION_LAYOUT_STORAGE_KEY;
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
    // Collaboration layout persistence is best-effort.
  }
}

function targetKey(target: WorkbenchPanelTarget) {
  return target.kind;
}

function collectTargets(node: WorkbenchMainLayoutNode, targets: Set<string>) {
  if (node.type === "leaf") {
    targets.add(targetKey(node.target));
    return;
  }

  collectTargets(node.first, targets);
  collectTargets(node.second, targets);
}

function hasRequiredCollaborationTargets(layout: WorkbenchMainLayoutState) {
  const targets = new Set<string>();
  collectTargets(layout.root, targets);
  return targets.has("collaborationScratchpad") && targets.has("collaborationCollaborator");
}

export function readStoredWorkbenchCollaborationLayout(projectId: string): WorkbenchMainLayoutState {
  if (typeof window === "undefined") {
    return createDefaultWorkbenchCollaborationLayout();
  }

  const layout = WorkbenchMainLayout.normalize(
    readJsonStorageValue(getProjectStorageKey(projectId)),
    { kind: "collaborationScratchpad" },
  );

  return hasRequiredCollaborationTargets(layout)
    ? layout
    : createDefaultWorkbenchCollaborationLayout();
}

export function writeStoredWorkbenchCollaborationLayout(projectId: string, layout: WorkbenchMainLayoutState) {
  if (typeof window === "undefined") {
    return;
  }

  writeJsonStorageValue(getProjectStorageKey(projectId), layout);
}
