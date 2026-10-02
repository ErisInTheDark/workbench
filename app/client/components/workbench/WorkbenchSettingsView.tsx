/*
 * Exports:
 * - default WorkbenchSettingsView: group real settings owners by page, logical project, daemon, and folder.
 */
"use client";

import { useEffect, useState } from "react";
import type { WorkbenchLocalCapabilitySettings, WorkbenchProjectOption } from "workbench-shared/types";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { DaemonId, LogicalProjectId } from "workbench-shared/workbench/identity";
import type { ProjectFolderOption } from "workbench-shared/workbench/project/project-folder-address";
import CommandApprovalSettings from "./CommandApprovalSettings";
import SandboxNetworkSettings from "./SandboxNetworkSettings";
import VoiceSettings from "./voice/VoiceSettings";
import { ProjectIcon } from "./workbench-icons";
import WorkbenchFormSection from "./WorkbenchFormSection";
import WorkbenchNetworkSettings from "./WorkbenchNetworkSettings";
import { WorkbenchOptionCard } from "./WorkbenchOptionCards";
import WorkbenchProjectDiscoverySettings from "./WorkbenchProjectDiscoverySettings";
import WorkbenchProjectIcon from "./WorkbenchProjectIcon";
import WorkbenchReactDevelopmentModeSetting from "./WorkbenchReactDevelopmentModeSetting";
import WorkbenchSettingsContextRow from "./WorkbenchSettingsContextRow";
import WorkbenchSettingsPreferences from "./WorkbenchSettingsPreferences";
import { WorkbenchOperationsContext } from "./WorkbenchWorkspaceContext";

type Page = "general" | "projects" | "agents" | "network";
const pages: { id: Page; label: string; sections: { id: string; label: string }[] }[] = [
  { id: "general", label: "General", sections: [
    { id: "settings-appearance", label: "Appearance" },
    { id: "settings-editing", label: "Editing" },
    { id: "settings-threads", label: "Threads" },
    { id: "settings-voice", label: "Voice" },
    { id: "settings-runtime", label: "Runtime" },
  ] },
  { id: "projects", label: "Projects & folders", sections: [
    { id: "settings-files", label: "Files" },
    { id: "settings-discovery", label: "Discovery" },
  ] },
  { id: "agents", label: "Agents", sections: [
    { id: "settings-agent-network", label: "Network access" },
    { id: "settings-capabilities", label: "Capabilities" },
    { id: "settings-permissions", label: "Permissions" },
  ] },
  { id: "network", label: "Networking", sections: [
    { id: "settings-connection", label: "Connection" },
    { id: "settings-daemons", label: "Daemons" },
    { id: "settings-app-access", label: "Access" },
  ] },
];
const defaultCapabilities: WorkbenchLocalCapabilitySettings = { browseRawCommandsEnabled: false };


function BrowseCapability({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const [settings, setSettings] = useState(defaultCapabilities);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void daemon.localCapabilities.read().then(payload => {
      if (!cancelled) setSettings(payload.localCapabilities);
    }).catch((failure: Error) => {
      if (!cancelled) setError(failure.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [daemon]);
  function update() {
    if (loading) return;
    setLoading(true);
    setError("");
    void daemon.localCapabilities.update({ localCapabilities: {
      browseRawCommandsEnabled: !settings.browseRawCommandsEnabled,
    } }).then(payload => setSettings(payload.localCapabilities))
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setLoading(false));
  }
  return <div className="py-1">
    <WorkbenchOptionCard label="Raw Browse commands"
      description="Allow raw Browse CLI usage outside the sandbox."
      isSingleChoice={false} isChecked={settings.browseRawCommandsEnabled}
      disabled={loading} onClick={update} />
    {error ? <p role="alert" className="m-0 text-xs text-danger">{error}</p> : null}
  </div>;
}

export default function WorkbenchSettingsView({
  attachedDaemonId,
  daemons,
  folders,
  getDaemon,
  logicalProject,
  onError,
  onGitRootsSaved,
  onPageChange,
  selectionError,
  selectionPending,
}: {
  attachedDaemonId: DaemonId | null;
  daemons: readonly { id: DaemonId; hostname: string }[];
  folders: readonly ProjectFolderOption[];
  getDaemon: (id: DaemonId) => WorkbenchDaemonClient | null;
  logicalProject: { id: LogicalProjectId; label: string; iconProject: WorkbenchProjectOption | null } | null;
  onError: (message: string) => void;
  onGitRootsSaved: (daemonId: DaemonId) => Promise<void>;
  onPageChange: (title: string) => void;
  selectionError: string | null;
  selectionPending: boolean;
}) {
  const [page, setPage] = useState<Page>("general");
  const [chosenDaemonId, setChosenDaemonId] = useState<DaemonId | null>(null);
  const [chosenFolderKey, setChosenFolderKey] = useState("");
  const daemonId = daemons.some(item => item.id === chosenDaemonId) ? chosenDaemonId
    : daemons.find(item => item.id === attachedDaemonId)?.id ?? daemons[0]?.id ?? null;
  const daemon = daemonId ? getDaemon(daemonId) : null;
  const daemonFolders = folders.filter(folder => folder.target.daemonId === daemonId && folder.project);
  const folder = daemonFolders.find(item => `${item.target.daemonId}/${item.target.projectId}` === chosenFolderKey)
    ?? daemonFolders[0] ?? null;
  const visibleSections = pages.find(item => item.id === page)!.sections
    .filter(item => item.id !== "settings-permissions" || logicalProject);

  useEffect(() => { onPageChange(pages.find(item => item.id === page)!.label); }, [onPageChange, page]);
  if (selectionPending) return <p role="status" className="mx-auto max-w-content px-5 py-6 text-sm text-fg/muted">Loading project selection...</p>;
  if (selectionError) return <p role="alert" className="mx-auto max-w-content px-5 py-6 text-sm text-danger">{selectionError}</p>;

  const daemonControl = <WorkbenchSettingsContextRow label="Daemon" value={daemonId ?? ""}
    options={daemons.map(item => ({ id: item.id, label: item.hostname }))}
    onSelect={id => { setChosenDaemonId(id as DaemonId); setChosenFolderKey(""); }} />;
  return <div className="mx-auto w-full max-w-content px-5 pb-10 pt-1 text-text md:max-w-[calc(var(--container-content)+13.25rem)]">
    <div className="grid gap-5 md:grid-cols-[11rem_minmax(0,1fr)] lg:gap-9">
      <aside className="scrollbar-hover-reveal hidden md:sticky md:top-20 md:block md:max-h-[calc(100dvh-6rem)] md:self-start md:overflow-y-auto">
        <div className="mb-3 flex min-w-0 items-center gap-2 px-2 py-2 text-sm text-text">
          {logicalProject?.iconProject ? <WorkbenchProjectIcon project={logicalProject.iconProject} />
            : logicalProject ? <ProjectIcon aria-hidden="true" className="size-5 shrink-0" />
            : <svg aria-hidden="true" className="size-5 shrink-0" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
              <path d="M2 12h20" />
            </svg>}
          <span className="min-w-0 truncate">{logicalProject ? `${logicalProject.label} settings` : "Global settings"}</span>
        </div>
        <nav aria-label="Settings sections" className="space-y-1">
          {pages.map(item => <div key={item.id}>
            <button type="button" aria-current={page === item.id ? "page" : undefined}
              onClick={() => setPage(item.id)}
              className={`block w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-fg/5 ${page === item.id
                ? "bg-fg/5 font-semibold text-text" : "text-fg/muted"}`}>{item.label}</button>
            {page === item.id ? <div className="mb-1 ml-3 flex flex-col">
              {visibleSections.map(section => <a key={section.id} href={`#${section.id}`}
                className="rounded-lg px-2 py-1 text-xs text-fg/muted hover:bg-fg/5 hover:text-text">{section.label}</a>)}
            </div> : null}
          </div>)}
        </nav>
      </aside>
      <div className="min-w-0">
        <div className="mb-3 md:hidden">
          <p className="m-0 mb-2 text-sm">{logicalProject ? `${logicalProject.label} settings` : "Global settings"}</p>
          <nav aria-label="Settings pages" className="flex gap-1 overflow-x-auto scrollbar-hover-reveal">
            {pages.map(item => <button key={item.id} type="button" onClick={() => setPage(item.id)}
              aria-current={page === item.id ? "page" : undefined}
              className={`shrink-0 rounded-lg px-2 py-2 text-sm hover:bg-fg/5 ${page === item.id
                ? "font-semibold text-text" : "text-fg/muted"}`}>{item.label}</button>)}
          </nav>
        </div>
        {page === "general" ? <>
          <WorkbenchFormSection id="settings-appearance" title="Appearance">
            <WorkbenchSettingsPreferences keys={["theme", "editorFontSize"]} logicalProjectId={logicalProject?.id ?? null} onError={onError} />
          </WorkbenchFormSection>
          <WorkbenchFormSection id="settings-editing" title="Editing">
            <WorkbenchSettingsPreferences keys={["editorFontFamily", "editorSpellCheck", "composerSpellCheck"]}
              logicalProjectId={logicalProject?.id ?? null} onError={onError} />
          </WorkbenchFormSection>
          <WorkbenchFormSection id="settings-threads" title="Threads">
            <WorkbenchSettingsPreferences keys={["threadCodeBlockWrap", "threadCodeDetails"]}
              logicalProjectId={logicalProject?.id ?? null} onError={onError} />
          </WorkbenchFormSection>
          <WorkbenchFormSection id="settings-voice" title="Voice"><VoiceSettings /></WorkbenchFormSection>
          <WorkbenchFormSection id="settings-runtime" title="Runtime"><WorkbenchReactDevelopmentModeSetting /></WorkbenchFormSection>
        </> : null}
        {page === "projects" ? <>
          <WorkbenchFormSection id="settings-files" title="Files">
            <WorkbenchSettingsPreferences keys={["fileOpenBehavior", "showUnopenableFiles"]}
              logicalProjectId={logicalProject?.id ?? null} onError={onError} />
          </WorkbenchFormSection>
          <WorkbenchFormSection id="settings-discovery" title="Discovery">
            <div className="space-y-3 py-3">
              {daemonControl}
              {daemon ? <WorkbenchOperationsContext.Provider value={daemon}>
                <WorkbenchProjectDiscoverySettings key={daemonId} onSaved={() => onGitRootsSaved(daemonId!)} />
              </WorkbenchOperationsContext.Provider> : <p role="status" className="text-sm text-fg/muted">No daemon available.</p>}
            </div>
          </WorkbenchFormSection>
        </> : null}
        {page === "agents" ? <>
          <WorkbenchFormSection id="settings-agent-network" title="Network access">
            {daemonControl}
            {logicalProject && daemonFolders.length > 1 ? <WorkbenchSettingsContextRow label="Folder"
              value={folder ? `${folder.target.daemonId}/${folder.target.projectId}` : ""}
              options={daemonFolders.map(item => ({
                id: `${item.target.daemonId}/${item.target.projectId}`,
                label: item.displayPath ?? `${item.hostname}:${item.rootPath}`,
              }))}
              onSelect={setChosenFolderKey} /> : null}
            {daemon ? <WorkbenchOperationsContext.Provider value={daemon}>
              <SandboxNetworkSettings key={`${daemonId}/${folder?.target.projectId ?? ""}`}
                projectId={logicalProject ? folder?.target.projectId ?? null : null}
                scope={logicalProject ? "project" : "global"} />
            </WorkbenchOperationsContext.Provider> : <p role="status" className="text-sm text-fg/muted">No daemon available.</p>}
            {logicalProject && !folder ? <p role="status" className="text-sm text-fg/muted">No folder is available on this daemon.</p> : null}
          </WorkbenchFormSection>
          <WorkbenchFormSection id="settings-capabilities" title="Capabilities">
            {daemon ? <BrowseCapability key={daemonId} daemon={daemon} /> : null}
          </WorkbenchFormSection>
          {logicalProject ? <WorkbenchFormSection id="settings-permissions" title="Permissions">
            {daemon && folder ? <WorkbenchOperationsContext.Provider value={daemon}>
              <CommandApprovalSettings key={`${daemonId}/${folder.target.projectId}`}
                projectId={folder.target.projectId} folders={daemonFolders} />
            </WorkbenchOperationsContext.Provider>
              : <p role="status" className="text-sm text-fg/muted">Choose an available folder to edit permissions.</p>}
          </WorkbenchFormSection> : null}
        </> : null}
        {page === "network" ? <WorkbenchNetworkSettings /> : null}
      </div>
    </div>
  </div>;
}
