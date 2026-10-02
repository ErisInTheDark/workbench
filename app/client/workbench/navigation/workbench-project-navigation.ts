/*
 * Exports:
 * - default WorkbenchProjectNavigation: maintain current project addresses and resolve routes, hrefs, and live thread owners.
 */
import type { WorkbenchLogicalProject, WorkbenchProjectAlias, WorkbenchProjectOption } from "workbench-shared/types";
import {
  createHomeRoute, createInvalidWorkbenchRoute, createProjectRoute, createWorkbenchHref,
  parseWorkbenchRouteFromLocation, withProjectSelection, type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import {
  ProjectFolderAddress, projectFolderOptions, type ProjectFolderOption,
} from "workbench-shared/workbench/project/project-folder-address";

export default class WorkbenchProjectNavigation {
  private readonly addressOwners = new Map<string, Set<WorkbenchLogicalProject>>();
  private folders: readonly ProjectFolderOption[] = [];
  private attached: { daemonId: ProjectLocationReference["daemonId"]; hostname: string } | null = null;

  constructor(
    private projects: readonly WorkbenchProjectOption[],
    private aliases: readonly WorkbenchProjectAlias[],
    private logicalProjects: readonly WorkbenchLogicalProject[] = [],
    readonly threadLocation?: (threadId: string) => ProjectLocationReference | null,
    attached?: { daemonId: ProjectLocationReference["daemonId"]; hostname: string } | null,
  ) {
    this.attached = attached ?? null;
    this.rebuildAddressOwners();
  }

  update(
    projects: readonly WorkbenchProjectOption[],
    aliases: readonly WorkbenchProjectAlias[],
    logicalProjects: readonly WorkbenchLogicalProject[],
    attached?: { daemonId: ProjectLocationReference["daemonId"]; hostname: string } | null,
  ) {
    const attachedChanged = attached !== undefined
      && (this.attached?.daemonId !== attached?.daemonId || this.attached?.hostname !== attached?.hostname);
    if (attached !== undefined) this.attached = attached;
    if (!attachedChanged && this.projects === projects && this.logicalProjects === logicalProjects
      && this.aliases.length === aliases.length
      && this.aliases.every((alias, index) => alias.alias === aliases[index]?.alias
        && alias.projectId === aliases[index]?.projectId)) return;
    this.projects = projects;
    this.aliases = aliases;
    this.logicalProjects = logicalProjects;
    this.addressOwners.clear();
    this.rebuildAddressOwners();
  }

  private rebuildAddressOwners() {
    this.folders = projectFolderOptions(this.logicalProjects, this.projects, this.attached);
    const add = (address: string, project: WorkbenchLogicalProject) => {
      if (!address) return;
      const owners = this.addressOwners.get(address) ?? new Set<WorkbenchLogicalProject>();
      owners.add(project);
      this.addressOwners.set(address, owners);
    };
    for (const project of this.logicalProjects) {
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
        for (const alias of this.aliases) {
          if (alias.projectId === location.project.id) add(alias.alias, project);
        }
      }
    }
  }

  resolveRoute(route: WorkbenchRoute): WorkbenchRoute {
    if (route.view === "invalid") return route;
    if (route.logical) return route;
    const selected = route.selectedProjectIds?.map(address => this.logicalForAddress(address)) ?? null;
    const owner = this.logicalForAddress(route.threadOwnerProjectId);
    if (selected?.includes("ambiguous") || owner === "ambiguous") {
      return createInvalidWorkbenchRoute("Project address matches multiple remote identities.");
    }
    if (selected?.some(Boolean) || owner) {
      if (selected?.some(project => !project) || (route.threadOwnerProjectId && !owner)) {
        return createInvalidWorkbenchRoute("The link mixes unresolved and logical project addresses.");
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

  /** Resolve one url folder address against the known folder universe. Unknown or ambiguous addresses select no folder. */
  folderForAddress(address: readonly string[]): ProjectLocationReference | null {
    return ProjectFolderAddress.resolve(this.folders, address)?.target ?? null;
  }

  /** Resolve the route's url folder within its project selection. Out-of-scope folders select no folder. */
  folderForRoute(route: WorkbenchRoute): ProjectLocationReference | null {
    if (!route.folderAddress?.length) {
      const ownerProjectId =
        route.logical?.projectId ?? route.logical?.threadOwnerProjectId;

      if (!ownerProjectId) return null;

      const ownFolders = this.folders.filter(folder =>
        folder.ownerProjectId === ownerProjectId
        && this.isProjectOwnFolder(folder)
      );

      return ownFolders.length === 1
        ? ownFolders[0]!.target
        : null;
    }

    const folder = ProjectFolderAddress.resolve(this.folders, route.folderAddress);
    if (!folder) return null;

    return route.selectedProjectIds && !route.selectedProjectIds.includes(folder.ownerProjectId)
      ? null
      : folder.target;
  }

  /** Derive one folder's url address segments. Null when the address is redundant with its project. */
  folderAddressFor(target: ProjectLocationReference): string[] | null {
    const address = ProjectFolderAddress.forFolder(this.folders, target);
    if (!address.length) return null;
    return this.isProjectOwnFolder(this.folders.find(folder =>
      folder.target.daemonId === target.daemonId && folder.target.projectId === target.projectId)) ? null : address;
  }

  /** A folder whose address equals its owning project's address is that project's own folder. */
  private isProjectOwnFolder(folder: ProjectFolderOption | undefined): boolean {
    if (!folder) return false;
    const owner = this.logicalProjects.find(project => project.id === folder.ownerProjectId);
    const ownerAddress = owner ? this.canonicalAddress(owner) : this.address(folder.ownerProjectId, []);
    return !!ownerAddress && ProjectFolderAddress.forFolder(this.folders, folder.target).join("/") === ownerAddress;
  }

  /** Every folder available to the sidebar folder picker for the selected projects. */
  folderOptions(selectedProjectIds?: readonly string[]): ProjectFolderOption[] {
    return selectedProjectIds
      ? this.folders.filter(folder => selectedProjectIds.includes(folder.ownerProjectId))
      : [...this.folders];
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
    const withFolder = intent.folderAddress === undefined && selection === "inherit" && current?.folderAddress?.length
      ? { ...intent, folderAddress: [...current.folderAddress] }
      : intent;
    const resolved = this.resolveRoute(withFolder);
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
      const selectedAddresses = resolved.selectedProjectIds?.map(id => {
        const project = this.logicalProjects.find(candidate => candidate.id === id)
          ?? this.logicalForAddress(id);
        if (project === "ambiguous") return undefined;
        return project ? this.canonicalAddress(project) : undefined;
      }) ?? null;
      if (selectedAddresses?.includes(undefined)) return undefined;
      return createWorkbenchHref({
        ...resolved,
        logical: undefined,
        projectId: selectedAddresses?.length === 1 ? ProjectIdSchema.parse(selectedAddresses[0]!) : "",
        selectedProjectIds: selectedAddresses as string[] | null,
        threadOwnerProjectId: owner ? ProjectIdSchema.parse(this.canonicalAddress(owner)) : "",
      });
    }
    const preferred = current ? [current.projectId, current.threadOwnerProjectId] : [];
    const projectId = this.address(withFolder.projectId, preferred);
    const ownerId = this.address(withFolder.threadOwnerProjectId, preferred);
    const selectedAddresses = withFolder.selectedProjectIds?.map(id => this.address(id, preferred)) ?? null;
    if (projectId === undefined || ownerId === undefined || selectedAddresses?.includes(undefined)) return undefined;
    return createWorkbenchHref({
      ...withFolder, projectId: projectId ? ProjectIdSchema.parse(projectId) : "",
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
