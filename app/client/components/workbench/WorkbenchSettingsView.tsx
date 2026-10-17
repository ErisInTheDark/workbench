/*
 * Exports:
 * - default WorkbenchSettingsView: app-wide settings pages plus one Agents and Projects page per machine, picked from the settings rail.
 */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { WorkbenchLogicalProject } from "workbench-shared/types";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { DaemonId, LogicalProjectId } from "workbench-shared/workbench/identity";
import type { ProjectFolderOption } from "workbench-shared/workbench/project/project-folder-address";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import ApprovalReviewSettings from "./ApprovalReviewSettings";
import CommandApprovalSettings from "./CommandApprovalSettings";
import WorkbenchEnvironmentSettings from "./environment/WorkbenchEnvironmentSettings";
import SandboxNetworkSettings from "./SandboxNetworkSettings";
import VoiceSettings, { VoiceInputSetting } from "./voice/VoiceSettings";
import ThreadAutoCompactSettings from "./ThreadAutoCompactSettings";
import FormSection from "../ui/FormSection";
import WorkbenchBrowseCapabilitySetting from "./WorkbenchBrowseCapabilitySetting";
import WorkbenchNetworkSettings from "./WorkbenchNetworkSettings";
import WorkbenchProjectDiscoverySettings from "./WorkbenchProjectDiscoverySettings";
import WorkbenchProjectLocationMenu from "./WorkbenchProjectLocationMenu";
import WorkbenchProviderRuntimeSettings from "./WorkbenchProviderRuntimeSettings";
import WorkbenchReactDevelopmentModeSetting from "./WorkbenchReactDevelopmentModeSetting";
import WorkbenchRepoPrerequisiteSettings from "./WorkbenchRepoPrerequisiteSettings";
import WorkbenchSettingsPreferences from "./WorkbenchSettingsPreferences";
import WorkbenchProjectPreferenceSettings from "./WorkbenchProjectPreferenceSettings";
import WorkbenchThemeSetting from "./WorkbenchThemeSetting";
import { WorkbenchOperationsContext } from "./WorkbenchWorkspaceContext";
import ChevronIcon from "./ChevronIcon";
import { ComputerIcon } from "./workbench-icons";

type AppPage = "general" | "network";
type MachinePage = "agents" | "projects";
type Place = { kind: "app"; page: AppPage } | { kind: "machine"; page: MachinePage; daemonId: DaemonId };
type Section = { id: string; label: string };

const appPages: { id: AppPage; label: string; sections: Section[] }[] = [
  { id: "general", label: "General", sections: [
    { id: "settings-appearance", label: "Appearance" },
    { id: "settings-editing", label: "Editing & files" },
    { id: "settings-git", label: "Git" },
    { id: "settings-voice", label: "Voice" },
    { id: "settings-advanced", label: "Advanced" },
  ] },
  { id: "network", label: "Networking", sections: [
    { id: "settings-connection", label: "Connection" },
    { id: "settings-app-access", label: "Network rules" },
  ] },
];
const machinePages: { id: MachinePage; label: string; sections: Section[] }[] = [
  { id: "agents", label: "Agents", sections: [
    { id: "settings-providers", label: "Providers" },
    { id: "settings-auto-compact", label: "Auto-compact" },
    { id: "settings-auto-approve", label: "Auto-approve" },
    { id: "settings-agent-network", label: "Network access" },
    { id: "settings-machine-voice", label: "Voice" },
    { id: "settings-capabilities", label: "Capabilities" },
  ] },
  { id: "projects", label: "Projects", sections: [
    { id: "settings-discovery", label: "Discovery" },
    { id: "settings-folder", label: "Folder" },
    { id: "settings-folder-network", label: "Network access" },
    { id: "settings-environment", label: "Environment" },
    { id: "settings-permissions", label: "Permissions" },
  ] },
];

const folderSectionIds = new Set(["settings-folder-network", "settings-environment", "settings-permissions"]);

function folderKey(location: ProjectLocationReference) {
  return `${location.daemonId}/${location.projectId}`;
}

function placeKey(place: Place) {
  return place.kind === "app" ? place.page : `${place.daemonId}/${place.page}`;
}

function initialPlace(section: string | null, daemonId: DaemonId | null): Place {
  const machinePage = machinePages.find(page => page.sections.some(item => item.id === section));
  if (machinePage && daemonId) return { kind: "machine", page: machinePage.id, daemonId };
  return { kind: "app", page: appPages.find(page => page.sections.some(item => item.id === section))?.id ?? "general" };
}

function Unavailable({ children }: { children: ReactNode }) {
  return <p role="status" className="m-0 py-1 text-sm text-fg/muted">{children}</p>;
}

function RailButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button type="button" aria-current={active ? "page" : undefined} onClick={onClick} className={`
    block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-fg/5
    ${active ? "bg-fg/5 font-semibold text-text" : "text-fg/muted"}
  `}>{label}</button>;
}

function RailSections({ sections }: { sections: readonly Section[] }) {
  return <div className="mb-1 ml-3 flex flex-col">
    {sections.map(section => <a key={section.id} href={`#${section.id}`}
      className="rounded-lg px-2 py-1 text-xs text-fg/muted hover:bg-fg/5 hover:text-text">{section.label}</a>)}
  </div>;
}

export default function WorkbenchSettingsView({
  attachedDaemonId,
  daemons: reachableDaemons,
  folders,
  getDaemon,
  getFolderDaemon,
  initialSection = null,
  initialDaemonId = null,
  logicalProject,
  projects,
  onError,
  onGitRootsSaved,
  selectionError,
  selectionPending,
}: {
  attachedDaemonId: DaemonId | null;
  daemons: readonly { id: DaemonId; hostname: string }[];
  /** Every folder of the projects the sidebar makes reachable; each machine's Projects page lists its own. */
  folders: readonly ProjectFolderOption[];
  getDaemon: (id: DaemonId) => WorkbenchDaemonClient | null;
  getFolderDaemon: (location: ProjectLocationReference) => WorkbenchDaemonClient | null;
  /** Section to open and scroll to on mount, such as `settings-auto-approve`. */
  initialSection?: string | null;
  initialDaemonId?: DaemonId | null;
  /** The single selected project, which picks the default machine and enables React Scan for Workbench's own source. */
  logicalProject: { id: LogicalProjectId; label: string; iconProject: WorkbenchLogicalProject } | null;
  /** Projects the sidebar reaches; Editing & files can give each its own overrides. */
  projects: readonly { id: LogicalProjectId; label: string; iconProject: WorkbenchLogicalProject }[];
  onError: (message: string) => void;
  onGitRootsSaved: (daemonId: DaemonId) => Promise<void>;
  selectionError: string | null;
  selectionPending: boolean;
}) {
  const daemons = reachableDaemons.toSorted((left, right) => Number(right.id === attachedDaemonId) - Number(left.id === attachedDaemonId)
    || left.hostname.localeCompare(right.hostname));
  const projectDaemonId = logicalProject?.iconProject.locations.find(location => location.project?.kind === "daemon")?.daemonId;
  const defaultDaemonId = daemons.find(item => item.id === projectDaemonId)?.id
    ?? daemons.find(item => item.id === attachedDaemonId)?.id ?? daemons[0]?.id ?? null;
  const [chosenPlace, setPlace] = useState<Place>(() => initialPlace(
    initialSection ?? (globalThis.location?.hash.slice(1) || null), initialDaemonId ?? defaultDaemonId));
  const place: Place = chosenPlace.kind === "machine" && !daemons.some(item => item.id === chosenPlace.daemonId)
    && chosenPlace.daemonId !== initialDaemonId
    ? { kind: "app", page: "general" } : chosenPlace;
  const [chosenFolderKey, setChosenFolderKey] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<DaemonId>>(() => new Set());
  useEffect(() => {
    if (initialSection) document.getElementById(initialSection)?.scrollIntoView({ block: "start" });
  }, [initialSection]);

  const machine = place.kind === "machine" ? daemons.find(item => item.id === place.daemonId) ?? null : null;
  const daemon = machine ? getDaemon(machine.id) : null;
  const machineFolders = machine ? folders.filter(item => item.project && item.target.daemonId === machine.id) : [];
  const folder = machineFolders.find(item => folderKey(item.target) === chosenFolderKey) ?? machineFolders[0] ?? null;
  const folderDaemon = folder ? getFolderDaemon(folder.target) : null;
  if (selectionPending) return <p role="status" className="mx-auto max-w-content px-5 py-6 text-sm text-fg/muted">Loading project selection...</p>;
  if (selectionError) return <p role="alert" className="mx-auto max-w-content px-5 py-6 text-sm text-danger">{selectionError}</p>;

  const withDaemon = (render: (client: WorkbenchDaemonClient, id: DaemonId) => ReactNode) =>
    daemon && machine ? render(daemon, machine.id) : <Unavailable>This machine is not connected.</Unavailable>;
  const withFolder = (render: (item: ProjectFolderOption, client: WorkbenchDaemonClient) => ReactNode) =>
    folder && folderDaemon ? render(folder, folderDaemon) : <Unavailable>No folder is available.</Unavailable>;
  const preferences = (keys: Parameters<typeof WorkbenchSettingsPreferences>[0]["keys"]) =>
    <WorkbenchSettingsPreferences keys={keys} logicalProjectId={null} onError={onError} />;
  const activeKey = placeKey(place);
  const go = (next: Place) => {
    setPlace(next);
    document.querySelector("main")?.scrollTo({ top: 0 });
  };
  const places: { place: Place; label: string }[] = [
    ...appPages.map(page => ({ place: { kind: "app", page: page.id } as Place, label: page.label })),
    ...daemons.flatMap(item => machinePages.map(page => ({
      place: { kind: "machine", page: page.id, daemonId: item.id } as Place,
      label: `${item.hostname} ${page.label}`,
    }))),
  ];

  return <div className="w-full px-5 pb-10 pt-1 text-text md:grid md:grid-cols-[minmax(11rem,1fr)_minmax(0,var(--container-content))_minmax(0,1fr)] md:gap-x-6 md:px-6">
    <aside className="scrollbar-hover-reveal hidden md:sticky md:top-20 md:flex md:max-h-[calc(100dvh-6rem)] md:justify-end md:self-start md:overflow-y-auto">
      <nav aria-label="Settings sections" className="w-44 space-y-0.5 pt-6">
        {appPages.map(page => {
          const active = place.kind === "app" && place.page === page.id;
          return <div key={page.id}>
            <RailButton active={active} label={page.label} onClick={() => go({ kind: "app", page: page.id })} />
            {active ? <RailSections sections={page.sections} /> : null}
          </div>;
        })}
        {daemons.map(item => <div key={item.id} className="pt-3">
          <button type="button" aria-expanded={!collapsed.has(item.id)} title={item.hostname}
            onClick={() => setCollapsed(current => {
              const next = new Set(current);
              if (!next.delete(item.id)) next.add(item.id);
              return next;
            })}
            className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium text-fg/muted hover:bg-fg/5 hover:text-text">
            <ComputerIcon size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{item.hostname}</span>
            <ChevronIcon size={14} className={`shrink-0 transition-transform ${collapsed.has(item.id) ? "-rotate-90" : ""}`} />
          </button>
          {collapsed.has(item.id) ? null : machinePages.map(page => {
            const active = place.kind === "machine" && place.daemonId === item.id && place.page === page.id;
            return <div key={page.id}>
              <RailButton active={active} label={page.label} onClick={() => go({ kind: "machine", page: page.id, daemonId: item.id })} />
              {active ? <RailSections sections={page.sections.filter(section =>
                section.id === "settings-machine-voice" ? item.id === attachedDaemonId
                  : !folderSectionIds.has(section.id) || Boolean(folder))} /> : null}
            </div>;
          })}
        </div>)}
      </nav>
    </aside>
    <div className="mx-auto w-full min-w-0 max-w-content md:mx-0">
      <div className="mb-3 md:hidden">
        <nav aria-label="Settings pages" className="flex gap-1 overflow-x-auto scrollbar-hover-reveal">
          {places.map(item => <button key={placeKey(item.place)} type="button" onClick={() => go(item.place)}
            aria-current={placeKey(item.place) === activeKey ? "page" : undefined}
            className={`
              inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-2 text-sm hover:bg-fg/5
              ${placeKey(item.place) === activeKey ? "font-semibold text-text" : "text-fg/muted"}
            `}>
            {item.place.kind === "machine" ? <ComputerIcon size={14} className="shrink-0" /> : null}
            {item.label}
          </button>)}
        </nav>
      </div>
      {place.kind === "app" && place.page === "general" ? <>
        <FormSection id="settings-appearance" title="Appearance">
          <WorkbenchThemeSetting logicalProjectId={null} onError={onError} />
          {preferences(["editorFontSize"])}
        </FormSection>
        <WorkbenchProjectPreferenceSettings id="settings-editing" projects={projects} onError={onError} />
        <FormSection id="settings-git" title="Git">
          {preferences(["gitPeerSyncMode"])}
        </FormSection>
        <FormSection id="settings-voice" title="Voice"><VoiceInputSetting /></FormSection>
        <FormSection id="settings-advanced" title="Advanced">
          {preferences(["threadCodeDetails"])}
          <WorkbenchReactDevelopmentModeSetting projectRootPaths={logicalProject?.iconProject.locations.map(location => location.rootPath) ?? []} />
        </FormSection>
      </> : null}
      {place.kind === "app" && place.page === "network" ? <WorkbenchNetworkSettings /> : null}
      {place.kind === "machine" && place.page === "agents" ? <>
        <FormSection id="settings-providers" title="Providers">
          {withDaemon((client, id) => <WorkbenchProviderRuntimeSettings key={id} daemon={client} />)}
        </FormSection>
        <FormSection id="settings-auto-compact" title="Auto-compact">
          {withDaemon((client, id) => <ThreadAutoCompactSettings key={id} daemon={client} />)}
        </FormSection>
        <FormSection id="settings-auto-approve" title="Auto-approve">
          {withDaemon((client, id) => <WorkbenchOperationsContext.Provider key={id} value={client}>
            <ApprovalReviewSettings />
          </WorkbenchOperationsContext.Provider>)}
        </FormSection>
        <FormSection id="settings-agent-network" title="Network access">
          {withDaemon((client, id) => <WorkbenchOperationsContext.Provider key={id} value={client}>
            <SandboxNetworkSettings projectId={null} scope="global" />
          </WorkbenchOperationsContext.Provider>)}
        </FormSection>
        {machine?.id === attachedDaemonId ? <FormSection id="settings-machine-voice" title="Voice">
          <VoiceSettings />
        </FormSection> : null}
        <FormSection id="settings-capabilities" title="Capabilities">
          {withDaemon((client, id) => <div key={id}>
            <WorkbenchBrowseCapabilitySetting daemon={client} />
            <WorkbenchRepoPrerequisiteSettings daemon={client} />
          </div>)}
        </FormSection>
      </> : null}
      {place.kind === "machine" && place.page === "projects" ? <>
        <FormSection id="settings-discovery" title="Discovery">
          {withDaemon((client, id) => <WorkbenchOperationsContext.Provider key={id} value={client}>
            <WorkbenchProjectDiscoverySettings onSaved={() => onGitRootsSaved(id)} />
          </WorkbenchOperationsContext.Provider>)}
        </FormSection>
        <div id="settings-folder" className="mt-8 flex scroll-mt-24 flex-wrap items-center gap-x-2 gap-y-1 border-t border-fg/10 pt-6">
          <h2 className="m-0 text-base font-semibold text-text">Folder</h2>
          {machineFolders.length ? <WorkbenchProjectLocationMenu label="Folder" folders={machineFolders}
            selected={folder?.target ?? null} onSelect={location => setChosenFolderKey(folderKey(location))} /> : null}
        </div>
        {folder ? <>
          <FormSection id="settings-folder-network" title="Network access">
            {withFolder((item, client) => <WorkbenchOperationsContext.Provider key={folderKey(item.target)} value={client}>
              <SandboxNetworkSettings projectId={item.target.projectId} scope="project" />
            </WorkbenchOperationsContext.Provider>)}
          </FormSection>
          <FormSection id="settings-environment" title="Environment">
            {withFolder((item, client) => <WorkbenchOperationsContext.Provider key={folderKey(item.target)} value={client}>
              <WorkbenchEnvironmentSettings daemonId={item.target.daemonId} projectId={item.target.projectId} />
            </WorkbenchOperationsContext.Provider>)}
          </FormSection>
          <FormSection id="settings-permissions" title="Permissions">
            {withFolder((item, client) => <WorkbenchOperationsContext.Provider key={folderKey(item.target)} value={client}>
              <CommandApprovalSettings projectId={item.target.projectId} rootPath={item.rootPath} />
            </WorkbenchOperationsContext.Provider>)}
          </FormSection>
        </> : <Unavailable>None of the projects in the sidebar have a folder on this machine.</Unavailable>}
      </> : null}
    </div>
  </div>;
}
