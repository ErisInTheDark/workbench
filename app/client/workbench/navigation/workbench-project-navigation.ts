/*
 * Exports:
 * - default WorkbenchProjectNavigation: resolve selected readable project addresses and thread owners to logical identities.
 */
import type { WorkbenchLogicalProject, WorkbenchProjectAlias, WorkbenchProjectOption } from "workbench-shared/types";
import {
  createHomeRoute, createInvalidWorkbenchRoute, createProjectRoute, createWorkbenchHref,
  parseWorkbenchRouteFromLocation, withProjectSelection, type WorkbenchRoute,
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
    if (route.view === "invalid") return route;
    if (route.logical) {
      if (route.logical.projectId || !route.logical.location || route.selectedProjectIds === null) return route;
      const selected = route.selectedProjectIds.map(address => this.logicalForAddress(address));
      if (selected.includes("ambiguous")) return createInvalidWorkbenchRoute(
        "Observed folder selection matches multiple remote identities.");
      if (selected.some(project => !project)) return route;
      return { ...route, selectedProjectIds: selected.map(project => (project as WorkbenchLogicalProject).id) };
    }
    const selected = route.selectedProjectIds?.map(address => this.logicalForAddress(address)) ?? null;
    const owner = this.logicalForAddress(route.threadOwnerProjectId);
    if (selected?.includes("ambiguous") || owner === "ambiguous") {
      return createInvalidWorkbenchRoute("Project address matches multiple remote identities.");
    }
    if (selected?.some(Boolean) || owner) {
      if (selected?.some(project => !project) || (route.threadOwnerProjectId && !owner)) {
        return createInvalidWorkbenchRoute("The link mixes unresolved and logical project addresses.");
      }
      if (route.view === "settings" || route.view === "stats") {
        return createInvalidWorkbenchRoute("Project-specific settings and statistics are unavailable here.");
      }
      return {
        ...route,
        projectId: "",
        threadOwnerProjectId: "",
        selectedProjectIds: selected?.map(project => (project as WorkbenchLogicalProject).id) ?? null,
        logical: {
          projectId: selected?.length === 1 ? (selected[0] as WorkbenchLogicalProject).id : null,
          threadOwnerProjectId: owner?.id ?? (route.view === "thread" && selected?.length === 1
            && (route.threadTarget?.kind === "new" || route.threadTarget?.kind === "draft")
            ? (selected[0] as WorkbenchLogicalProject).id : null),
          location: null,
          browseLocation: null,
        },
      };
    }
    const projectId = this.resolveProjectId(route.projectId);
    const ownerId = this.resolveProjectId(route.threadOwnerProjectId);
    const selectedIds = route.selectedProjectIds?.map(address => this.resolveProjectId(address)) ?? null;
    return projectId === route.projectId && ownerId === route.threadOwnerProjectId
      && selectedIds?.every((id, index) => id === route.selectedProjectIds?.[index]) !== false ? route : {
      ...route, projectId: projectId ? ProjectIdSchema.parse(projectId) : "",
      threadOwnerProjectId: ownerId ? ProjectIdSchema.parse(ownerId) : "",
      selectedProjectIds: selectedIds,
    };
  }

  readRoute(location: string, launchProjectId?: string): WorkbenchRoute {
    const url = new URL(location, "http://workbench.local");
    return this.resolveRoute(url.pathname === "/launch"
      ? launchProjectId ? createProjectRoute(launchProjectId) : createHomeRoute()
      : parseWorkbenchRouteFromLocation(location));
  }

  href(route: WorkbenchRoute, current?: WorkbenchRoute,
    selection: "inherit" | "exact" = "exact"): string | undefined {
    const intent = selection === "inherit" && current && route.view === "thread"
      && (current.selectedProjectIds !== null || route.selectedProjectIds === null)
      ? withProjectSelection(route, current.selectedProjectIds) : route;
    const resolved = this.resolveRoute(intent);
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
      if (resolved.view === "thread" && !owner && !(logical.location && !logical.projectId)) return undefined;
      if (logical.projectId && !selected) return undefined;
      const selectedAddresses = resolved.selectedProjectIds?.map(id => {
        const project = this.logicalProjects.find(candidate => candidate.id === id)
          ?? this.logicalForAddress(id);
        if (project === "ambiguous") return undefined;
        return project ? this.canonicalAddress(project) : undefined;
      }) ?? null;
      if (selectedAddresses?.includes(undefined)) return undefined;
      if (!logical.projectId && logical.location) {
        return createWorkbenchHref({ ...resolved, selectedProjectIds: selectedAddresses as string[] | null });
      }
      return createWorkbenchHref({
        ...resolved,
        logical: undefined,
        projectId: selectedAddresses?.length === 1 ? ProjectIdSchema.parse(selectedAddresses[0]!) : "",
        selectedProjectIds: selectedAddresses as string[] | null,
        threadOwnerProjectId: owner ? ProjectIdSchema.parse(this.canonicalAddress(owner)) : "",
      });
    }
    const preferred = current ? [current.projectId, current.threadOwnerProjectId] : [];
    const projectId = this.address(intent.projectId, preferred);
    const ownerId = this.address(intent.threadOwnerProjectId, preferred);
    const selectedAddresses = intent.selectedProjectIds?.map(id => this.address(id, preferred)) ?? null;
    if (projectId === undefined || ownerId === undefined || selectedAddresses?.includes(undefined)) return undefined;
    return createWorkbenchHref({
      ...intent, projectId: projectId ? ProjectIdSchema.parse(projectId) : "",
      selectedProjectIds: selectedAddresses as string[] | null,
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
