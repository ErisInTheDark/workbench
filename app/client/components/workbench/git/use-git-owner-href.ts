/*
 * Exports:
 * - useGitOwnerHref: the href opening a thread that claims or committed Git work in the provided folder, when it resolves.
 */
"use client";
import type { GitCheckoutOwner } from "workbench-shared/workbench/git/git-object-contracts";
import { createLogicalExistingThreadRoute, createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import { useProjects } from "../use-projects";
import { useWorkingTreeDaemonId } from "./WorkbenchWorkingTreeProvider";

/** On a known daemon the thread opens through its logical project; otherwise through the physical one. */
export function useGitOwnerHref() {
  const projectHref = useWorkbenchProjectNavigation();
  const logicalProjects = useProjects();
  const daemonId = useWorkingTreeDaemonId();
  return (owner: GitCheckoutOwner | undefined) => {
    const target = owner && owner.entry.entryKind !== "draft" ? owner.entry.identity : null;
    if (!owner || !target) return undefined;
    if (!daemonId) return projectHref(createThreadRoute(owner.projectId, { kind: "provider", ...target }));
    const logical = logicalProjects.find(project => project.locations.some(location =>
      location.daemonId === daemonId && location.target.projectId === owner.projectId));
    return logical ? projectHref(createLogicalExistingThreadRoute(logical.id, { kind: "provider", ...target })) : undefined;
  };
}
