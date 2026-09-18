/*
 * Exports:
 * - default WorkbenchProjectNavigation: translate between public project addresses and internal route identities.
 */
import type { WorkbenchProjectAlias, WorkbenchProjectOption } from "workbench-shared/types";
import { createHomeRoute, createProjectRoute, createWorkbenchHref, parseWorkbenchRouteFromLocation, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";

export default class WorkbenchProjectNavigation {
  constructor(
    readonly projects: readonly WorkbenchProjectOption[],
    readonly aliases: readonly WorkbenchProjectAlias[],
  ) {}

  resolveRoute(route: WorkbenchRoute): WorkbenchRoute {
    const projectId = this.resolveProjectId(route.projectId);
    const ownerId = this.resolveProjectId(route.threadOwnerProjectId);
    return projectId === route.projectId && ownerId === route.threadOwnerProjectId ? route : {
      ...route, projectId: projectId ? ProjectIdSchema.parse(projectId) : "",
      threadOwnerProjectId: ownerId ? ProjectIdSchema.parse(ownerId) : "",
    };
  }

  readRoute(location: string, launchProjectId?: string): WorkbenchRoute {
    const url = new URL(location, "http://workbench.local");
    return this.resolveRoute(url.pathname === "/launch"
      ? launchProjectId ? createProjectRoute(launchProjectId) : createHomeRoute()
      : parseWorkbenchRouteFromLocation(location));
  }

  href(route: WorkbenchRoute, current?: WorkbenchRoute): string | undefined {
    const preferred = current ? [current.projectId, current.threadOwnerProjectId] : [];
    const projectId = this.address(route.projectId, preferred);
    const ownerId = this.address(route.threadOwnerProjectId, preferred);
    if (projectId === undefined || ownerId === undefined) return undefined;
    return createWorkbenchHref({
      ...route, projectId: projectId ? ProjectIdSchema.parse(projectId) : "",
      threadOwnerProjectId: ownerId ? ProjectIdSchema.parse(ownerId) : "",
    });
  }

  private resolveProjectId(address: string) {
    return this.aliases.find(alias => alias.alias === address)?.projectId
      ?? this.projects.find(project => project.relativePath === address)?.id
      ?? address;
  }

  private address(projectId: string, preferred: readonly string[]): string | undefined {
    if (!projectId) return "";
    const identity = this.resolveProjectId(projectId);
    const project = this.projects.find(project => project.id === identity);
    if (project) return project.relativePath;
    const existing = preferred.find(address => address && !address.includes("://") && this.resolveProjectId(address) === identity);
    if (existing) return existing;
    const aliases = this.aliases.filter(alias => alias.projectId === identity && !alias.alias.includes("://"))
      .map(alias => alias.alias).sort();
    return aliases[0] ?? (projectId.includes("://") ? undefined : projectId);
  }
}
