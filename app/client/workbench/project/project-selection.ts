/*
 * Exports:
 * - ProjectSelectionFacts: the project, group, listing and sidebar facts a project selection derives from.
 * - ProjectSelection: the route's displayed projects, project tiers, selected ids and projects, and create-thread project.
 * - resolveProjectSelection: derive the project selection from the route and its facts, falling back to listed rows and sidebars while groups are not current.
 */
import type {
  WorkbenchLogicalProject, WorkbenchLogicalProjectSummary, WorkbenchLogicalThreadRow, WorkbenchProjectOption,
} from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchProjectThreadSummaries } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchProjectThreadRowSidebars } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type { ProjectGroupFacts } from "./ProjectFactsStore";
import { resolveSelectedProjectIds } from "../../components/workbench/project-sidebar-groups";

export interface ProjectSelectionFacts {
  route: Pick<WorkbenchRoute, "selectedProjectIds" | "logical">;
  logicalProjects: readonly WorkbenchLogicalProject[];
  physicalProjects: readonly WorkbenchProjectOption[];
  groups: ProjectGroupFacts;
  logicalSummaries: Readonly<Record<string, WorkbenchLogicalProjectSummary>>;
  rows: readonly WorkbenchLogicalThreadRow[];
  rowsLoading: boolean;
  sidebars: WorkbenchProjectThreadRowSidebars;
  summaries: WorkbenchProjectThreadSummaries;
  /** Logical projects own thread creation when the app presentation is mounted. */
  presentationMode: boolean;
  browseLocation: ProjectLocationReference | null;
}

export interface ProjectSelection {
  /** Logical projects when any exist (or no physical ones do); undefined selects the physical folder sidebar. */
  displayedLogicalProjects: readonly WorkbenchLogicalProject[] | undefined;
  orderedProjectIds: readonly string[];
  unarchivedProjectIds: readonly string[];
  unsettledProjectIds: readonly string[];
  selectionProjectIds: readonly string[];
  /** A default selection waits for its first listing while groups are not current. */
  pending: boolean;
  selectedLogicalProject: WorkbenchLogicalProject | null;
  selectedLogicalProjects: readonly WorkbenchLogicalProject[];
  selectedPhysicalProjects: readonly WorkbenchProjectOption[];
  createProjectId: string;
}

export function resolveProjectSelection(facts: ProjectSelectionFacts): ProjectSelection {
  const { route, logicalProjects, physicalProjects } = facts;
  const displayedLogicalProjects = logicalProjects.length || !physicalProjects.length ? logicalProjects : undefined;
  const groups = displayedLogicalProjects && (facts.groups.phase === "current" || facts.groups.phase === "stale")
    ? facts.groups.data : null;
  const unarchivedProjectIds = [...new Set<string>(groups?.unarchivedProjectIds
    ?? (displayedLogicalProjects
      ? facts.rows.filter(row => row.entry.entryKind !== "subagent" && !row.entry.metadata.archived)
        .map(row => row.logicalProjectId)
      : facts.sidebars.projects.flatMap(sidebar => sidebar.entries
        .filter(entry => entry.entryKind !== "subagent" && !entry.metadata.archived)
        .map(() => sidebar.projectId))))];
  const unsettledProjectIds = [...new Set<string>(groups?.unsettledProjectIds
    ?? (displayedLogicalProjects
      ? displayedLogicalProjects.filter(project => facts.logicalSummaries[project.id]?.unsettledThreads.length)
        .map(project => project.id)
      : facts.summaries.projects.filter(summary => summary.unsettledThreads.length).map(summary => summary.projectId)))];
  const displayedIds = (displayedLogicalProjects ?? physicalProjects).map(project => project.id);
  const selectionProjectIds = resolveSelectedProjectIds(displayedIds, route.selectedProjectIds, new Set(unarchivedProjectIds));
  const selectedLogicalProjects = selectionProjectIds.flatMap(id => {
    const project = displayedLogicalProjects?.find(candidate => candidate.id === id);
    return project?.locations.some(location => location.project) ? [project] : [];
  });
  const selectedPhysicalProjects = selectionProjectIds.flatMap(id => {
    const project = physicalProjects.find(candidate => candidate.id === id);
    return project ? [project] : [];
  });
  const selectedLogicalProject = logicalProjects.find(project => project.id === route.logical?.projectId) ?? null;
  return {
    displayedLogicalProjects,
    orderedProjectIds: groups?.orderedProjectIds ?? displayedIds,
    unarchivedProjectIds,
    unsettledProjectIds,
    selectionProjectIds,
    pending: route.selectedProjectIds === null && !groups && facts.rowsLoading,
    selectedLogicalProject,
    selectedLogicalProjects,
    selectedPhysicalProjects,
    createProjectId: facts.presentationMode
      ? (selectedLogicalProject ?? selectedLogicalProjects[0])?.locations
        .find(location => location.project)?.target.projectId ?? facts.browseLocation?.projectId ?? ""
      : selectedPhysicalProjects[0]?.id || "",
  };
}
