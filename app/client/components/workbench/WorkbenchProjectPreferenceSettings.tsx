/*
 * Exports:
 * - default WorkbenchProjectPreferenceSettings: "Editing & files" defaults (including mark tags) plus per-project overrides.
 */
"use client";

import type { WorkbenchLogicalProject } from "workbench-shared/types";
import type { LogicalProjectId } from "workbench-shared/workbench/identity";
import { readLogicalProjectWorkbenchSettings, type WorkbenchSettingKey } from "../../workbench/state/workbench-settings";
import { useWorkbenchClientState } from "./workbench-client-state-context";
import ProjectScopedSettingsSection from "./ProjectScopedSettingsSection";
import WorkbenchSettingsPreferences from "./WorkbenchSettingsPreferences";
import WorkbenchSettingsRadioTable from "./WorkbenchSettingsRadioTable";

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
  const overridden = useWorkbenchClientState(state => projects.flatMap(project => PROJECT_SETTING_KEYS.some(key =>
    readLogicalProjectWorkbenchSettings(project.id, state.records)[key].enabled) ? [project.id] : []));
  return <ProjectScopedSettingsSection id={id} title="Editing & files" addLabel="Add project-specific overrides"
    defaultLabel="Default options" projects={projects} scopedProjectIds={overridden}
    renderScope={projectId => <PreferenceSet projectId={projectId} onError={onError} />} />;
}
