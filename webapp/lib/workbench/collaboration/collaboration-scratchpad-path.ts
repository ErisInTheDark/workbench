/*
 * Exports:
 * - DEFAULT_COLLABORATION_SCRATCHPAD_SETTING_VALUE: empty setting value that means use Workbench-owned per-project storage. Keywords: collaboration, scratchpad, settings.
 * - createWorkbenchCollaborationScratchpadRelativePath: build a project-scoped Workbench storage path. Keywords: collaboration, scratchpad, project id.
 * - createWorkbenchCollaborationScratchpadWritableRoot: build the absolute writable root for collaborator sandbox access. Keywords: collaboration, sandbox, writable root.
 * - isWorkbenchOwnedCollaborationScratchpadPath: identify Workbench-owned scratchpad paths. Keywords: collaboration, storage, path.
 */

export const DEFAULT_COLLABORATION_SCRATCHPAD_SETTING_VALUE = "";

const WORKBENCH_COLLABORATION_PROJECTS_PREFIX = ".workbench/collaboration/projects";
const WORKBENCH_COLLABORATION_SCRATCHPAD_FILE_NAME = "SCRATCHPAD.md";

export function encodeWorkbenchCollaborationProjectId(projectId: string) {
  return projectId
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "project";
}

export function createWorkbenchCollaborationScratchpadRelativePath(projectId: string) {
  return [
    WORKBENCH_COLLABORATION_PROJECTS_PREFIX,
    encodeWorkbenchCollaborationProjectId(projectId),
    WORKBENCH_COLLABORATION_SCRATCHPAD_FILE_NAME,
  ].join("/");
}

export function createWorkbenchCollaborationScratchpadWritableRoot(storageRootPath: string, projectId: string) {
  const trimmedStorageRootPath = storageRootPath.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!trimmedStorageRootPath) {
    return "";
  }

  return [
    trimmedStorageRootPath,
    WORKBENCH_COLLABORATION_PROJECTS_PREFIX,
    encodeWorkbenchCollaborationProjectId(projectId),
  ].join("/");
}

export function isWorkbenchOwnedCollaborationScratchpadPath(filePath: string) {
  const normalizedPath = filePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  return normalizedPath.startsWith(`${WORKBENCH_COLLABORATION_PROJECTS_PREFIX}/`)
    && normalizedPath.endsWith(`/${WORKBENCH_COLLABORATION_SCRATCHPAD_FILE_NAME}`);
}
