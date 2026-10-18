/*
 * Exports:
 * - default WorkbenchProjectPreferenceSettings: "Editing & files" defaults (including mark tags) plus one disclosure per
 *   project that overrides them.
 */
"use client";

import { useState } from "react";
import type { WorkbenchLogicalProject } from "workbench-shared/types";
import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import { readLogicalProjectWorkbenchSettings, type WorkbenchSettingKey } from "../../workbench/state/workbench-settings";
import Disclosure from "../ui/Disclosure";
import PressDragMenu from "../ui/PressDragMenu";
import { useWorkbenchClientStateSnapshot } from "./workbench-client-state-context";
import WorkbenchProjectIcon from "./WorkbenchProjectIcon";
import WorkbenchSettingsPreferences from "./WorkbenchSettingsPreferences";
import WorkbenchSettingsRadioTable from "./WorkbenchSettingsRadioTable";
import { PlusIcon } from "./workbench-icons";

const PROJECT_SETTING_KEYS = [
  "userName", "editorFontFamily", "editorSpellCheck", "composerSpellCheck",
  "openMarkdownFilesWith", "openSvgFilesWith", "openOtherFilesWith", "showUnopenableFiles", "markTags",
] as const satisfies readonly WorkbenchSettingKey[];

type Project = { id: LogicalProjectId; label: string; iconProject: WorkbenchLogicalProject };

function PreferenceSet({ projectId, onError }: { projectId: LogicalProjectId | null; onError: (message: string) => void }) {
  return <>
    <WorkbenchSettingsPreferences keys={["userName"]} logicalProjectId={projectId} onError={onError} />
    <WorkbenchSettingsRadioTable keys={["editorFontFamily"]} logicalProjectId={projectId} onError={onError} />
    <WorkbenchSettingsPreferences keys={["editorSpellCheck", "composerSpellCheck"]} logicalProjectId={projectId} onError={onError} />
    <WorkbenchSettingsPreferences keys={["markTags"]} logicalProjectId={projectId} onError={onError} />
    <WorkbenchSettingsRadioTable title="Open files with" description="Where file links and explorer clicks open, by file type."
      keys={["openMarkdownFilesWith", "openSvgFilesWith", "openOtherFilesWith"]} logicalProjectId={projectId} onError={onError} />
    <WorkbenchSettingsPreferences keys={["showUnopenableFiles"]} logicalProjectId={projectId} onError={onError} />
  </>;
}

export default function WorkbenchProjectPreferenceSettings({ id, projects, onError }: {
  id: string;
  /** Projects the sidebar reaches; only these can be given overrides here. */
  projects: readonly Project[];
  onError: (message: string) => void;
}) {
  const records = useWorkbenchClientStateSnapshot().records;
  const [added, setAdded] = useState<ReadonlySet<LogicalProjectId>>(() => new Set());
  const overriding = projects.filter(project => added.has(project.id) || PROJECT_SETTING_KEYS.some(key =>
    readLogicalProjectWorkbenchSettings(project.id, records)[key].enabled));
  const available = projects.filter(project => !overriding.includes(project));
  return <section id={id} className="scroll-mt-24 space-y-1">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 pb-1 pt-6">
      <h2 className="m-0 text-base font-semibold text-text">Editing & files</h2>
      {available.length ? <PressDragMenu
        label="Add project-specific overrides"
        align="end"
        triggerClassName="text-sm text-fg/muted"
        items={available.map(project => ({
          id: project.id,
          checked: false,
          content: <span className="flex min-w-0 items-center gap-2">
            <WorkbenchProjectIcon project={project.iconProject} variant="thread" />
            <span className="truncate">{project.label}</span>
          </span>,
        }))}
        onSelect={projectId => setAdded(current => new Set(current).add(projectId as LogicalProjectId))}
      ><PlusIcon size={16} className="shrink-0" /><span>Add project-specific overrides</span></PressDragMenu> : null}
    </div>
    {overriding.length ? <div className="space-y-2">
      <Disclosure summary="Default options" summaryClassName="py-2 text-sm" contentClassName="pl-6">
        <PreferenceSet projectId={null} onError={onError} />
      </Disclosure>
      {overriding.map(project => <Disclosure key={project.id} defaultOpen summaryClassName="py-2 text-sm text-text"
        contentClassName="pl-6"
        summary={<span className="flex min-w-0 items-center gap-2">
          <WorkbenchProjectIcon project={project.iconProject} variant="thread" />
          <span className="truncate">{project.label}</span>
        </span>}>
        <PreferenceSet projectId={project.id} onError={onError} />
      </Disclosure>)}
    </div> : <PreferenceSet projectId={null} onError={onError} />}
  </section>;
}
