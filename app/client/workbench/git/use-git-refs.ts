/*
 * Exports:
 * - useGitBranches: a folder's live local branches with upstream counts.
 * - useGitStashes: a folder's live stashes, newest first.
 */
"use client";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useWorkbenchWorkspace } from "../../components/workbench/WorkbenchWorkspaceContext";
import useWorkspaceObservation from "../app/use-workspace-observation";

export function useGitBranches(location: ProjectLocationReference | null) {
  return useWorkspaceObservation(useWorkbenchWorkspace(), location ? { kind: "gitBranches", location } : null).value?.data ?? null;
}

export function useGitStashes(location: ProjectLocationReference | null) {
  return useWorkspaceObservation(useWorkbenchWorkspace(), location ? { kind: "gitStashes", location } : null).value?.data ?? null;
}
