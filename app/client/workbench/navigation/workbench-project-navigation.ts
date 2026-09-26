/*
 * Exports:
 * - default WorkbenchProjectNavigation: resolve readable project addresses to one logical owner and write old-shape URLs.
 */
import type { WorkbenchLogicalProject, WorkbenchProjectAlias, WorkbenchProjectOption } from "workbench-shared/types";
import {
  createHomeRoute, createInvalidWorkbenchRoute, createProjectRoute, createWorkbenchHref,
  parseWorkbenchRouteFromLocation, type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";

export default class WorkbenchProjectNavigation {
  private readonly addressOwners = new Map<string, Set<WorkbenchLogicalProject>>();

  constructor(
    readonly projects: readonly WorkbenchProjectOption[],
    readonly aliases: readonly WorkbenchProjectAlias[],
    readonly logicalProjects: readonly WorkbenchLogicalProject[] = [],
    readonly threadLocation?: (threadId: string) => ProjectLocationReference | null,
  ) {
    const add = (address: string, project: WorkbenchLogicalProject) => {
      if (!address) return;
      const owners = this.addressOwners.get(address) ?? new Set<WorkbenchLogicalProject>();
      owners.add(project);
      this.addressOwners.set(address, owners);
    };
    for (const project of logicalProjects) {
      add(project.id, project);
      add(project.matchKey, project);
      for (const address of this.remoteAddresses(project)) add(address, project);
      if (!project.matchKey.startsWith("remote://")) {
        for (const address of this.localAddresses(project)) add(address, project);
        add(project.storedLabel ?? project.label, project);
      }
      for (const location of project.locations) {
        add(location.target.projectId, project);
        if (!location.project) continue;
        add(location.project.relativePath, project);
        for (const alias of aliases) {
          if (alias.projectId === location.project.id) add(alias.alias, project);
        }
      }
    }
  }

  resolveRoute(route: WorkbenchRoute): WorkbenchRoute {
    if (route.view === "invalid" || route.logical) return route;
    const selected = this.logicalForAddress(route.projectId);
    const owner = this.logicalForAddress(route.threadOwnerProjectId);
    if (selected === "ambiguous" || owner === "ambiguous") {
      return createInvalidWorkbenchRoute("Project address matches multiple remote identities.");
    }
    if (selected || owner) {
      if ((route.projectId && !selected) || (route.threadOwnerProjectId && !owner)) {
        return createInvalidWorkbenchRoute("The link mixes unresolved and logical project addresses.");
      }
      if (route.view === "settings" || route.view === "stats") {
        return createInvalidWorkbenchRoute("Project-specific settings and statistics are unavailable here.");
      }
      return {
        ...route,
        projectId: "",
        threadOwnerProjectId: "",
        logical: {
          projectId: selected?.id ?? null,
          threadOwnerProjectId: owner?.id ?? (route.view === "thread"
            && (route.threadTarget?.kind === "new" || route.threadTarget?.kind === "draft")
            ? selected?.id ?? null : null),
          location: null,
          browseLocation: null,
        },
      };
    }
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
    const resolved = this.resolveRoute(route);
    if (resolved.view === "invalid" || resolved.view === "mosaic") return undefined;
    if (resolved.logical) {
      const logical = resolved.logical;
      const selected = this.logicalProjects.find(project => project.id === logical.projectId);
      let owner = this.logicalProjects.find(project => project.id === logical.threadOwnerProjectId);
      if (resolved.view === "thread" && !owner
        && (resolved.threadTarget?.kind === "provider" || resolved.threadTarget?.kind === "subagent")) {
        const id = resolved.threadTarget.kind === "subagent"
          ? resolved.threadTarget.parentThreadId : resolved.threadTarget.threadId;
        const location = this.threadLocation?.(id);
        owner = this.logicalProjects.find(project => project.locations.some(item =>
          item.target.daemonId === location?.daemonId && item.target.projectId === location?.projectId)
          || project.observedLocations?.some(item =>
            item.daemonId === location?.daemonId && item.projectId === location?.projectId));
      }
      if (resolved.view === "thread" && !owner) return undefined;
      if (logical.projectId && !selected) return undefined;
      return createWorkbenchHref({
        ...resolved,
        logical: undefined,
        projectId: selected ? ProjectIdSchema.parse(this.canonicalAddress(selected)) : "",
        threadOwnerProjectId: owner ? ProjectIdSchema.parse(this.canonicalAddress(owner)) : "",
      });
    }
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

  private logicalForAddress(address: string): WorkbenchLogicalProject | "ambiguous" | null {
    const owners = this.addressOwners.get(address);
    return !owners?.size ? null : owners.size > 1 ? "ambiguous" : owners.values().next().value ?? null;
  }

  private remoteAddresses(project: WorkbenchLogicalProject) {
    if (!project.matchKey.startsWith("remote://")) return [];
    const identity = project.matchKey.slice("remote://".length);
    const urlText = identity.includes("://") ? identity : `https://${identity}`;
    if (!URL.canParse(urlText)) return [identity];
    const url = new URL(urlText);
    const parts = url.pathname.split("/").filter(Boolean);
    return [
      ...parts.map((_, index) => parts.slice(index).join("/")).reverse(),
      ...(url.host && parts.length ? [`${url.host}/${parts.join("/")}`] : []),
      identity,
    ];
  }

  private localAddresses(project: WorkbenchLogicalProject) {
    const relative = project.locations.flatMap(location => {
      const root = location.rootPath.replace(/\\/gu, "/");
      const absoluteParts = root.replace(/^[a-z]:\//iu, "").split("/").filter(Boolean);
      const parts = location.project?.relativePath.replace(/\\/gu, "/").split("/").filter(Boolean)
        ?? absoluteParts;
      return parts.map((_, index) => parts.slice(index).join("/")).reverse();
    });
    const absolute = [...project.locations.map(location => location.rootPath), project.label, project.storedLabel ?? ""]
      .flatMap(value => {
        const match = /^([a-z]):[/\\](.+)$/iu.exec(value);
        return match ? [`${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/gu, "/")}`] : [];
      });
    return [...relative, ...absolute];
  }

  private canonicalAddress(project: WorkbenchLogicalProject) {
    const candidates = project.matchKey.startsWith("remote://")
      ? this.remoteAddresses(project)
      : [...this.localAddresses(project), ...[project.label, project.storedLabel ?? ""]
        .filter(address => !address.includes("://") && !/^[a-z]:[/\\]/iu.test(address)), project.id];
    return candidates.find(address => this.addressOwners.get(address)?.size === 1
      && this.addressOwners.get(address)?.has(project)) ?? project.matchKey;
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
