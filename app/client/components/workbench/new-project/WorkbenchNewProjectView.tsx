/*
 * Exports:
 * - default WorkbenchNewProjectView: placement, template and name form that creates a Git project and adds it to the project selection.
 */
"use client";

import { useEffect, useId, useReducer, useRef, useState } from "react";

import {
  createLogicalProjectRoute,
  createProjectSelectionRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import {
  validateProjectFolderName,
  type ProjectCreateResult,
  type ProjectTemplate,
} from "workbench-shared/workbench/project/project-creation";
import PrimaryButton from "../../ui/PrimaryButton";
import type { WorkbenchRouteViewProps } from "../route-views/workbench-route-views";
import { useWorkbenchClientController } from "../workbench-client-context";
import FormSection from "../../ui/FormSection";
import WorkbenchSettingsContextRow from "../WorkbenchSettingsContextRow";
import WorkbenchTextField from "../WorkbenchTextField";
import { displayFolderPath, FolderPickerState } from "./folder-picker-state";
import WorkbenchFolderPicker from "./WorkbenchFolderPicker";

const TEMPLATES: readonly { id: ProjectTemplate; label: string }[] = [
  { id: "none", label: "None" },
  { id: "node", label: "Node.js" },
];
const REJECTION_MESSAGES: Record<Extract<ProjectCreateResult, { accepted: false }>["reason"], string> = {
  "invalid-name": "That project name cannot be used as a folder name.",
  exists: "A folder with that name already exists there.",
  "parent-missing": "The chosen folder no longer exists.",
  "outside-roots": "Choose a folder inside one of your project roots.",
  "inside-project": "That folder is inside an existing project. Choose a folder outside it.",
};

export default function WorkbenchNewProjectView ({ route, navigateToRoute }: WorkbenchRouteViewProps) {
  const mounted = useWorkbenchClientController().mounted;
  const nameId = useId();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<ProjectTemplate>("none");
  const [picker, dispatch] = useReducer(FolderPickerState.reduce, FolderPickerState.initial);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);

  const nameProblem = name ? validateProjectFolderName(name) : null;
  const parent = picker.mode === "place" ? FolderPickerState.target(picker) : null;
  const separator = parent?.path.includes("\\") ? "\\" : "/";
  const destination = parent && name && !nameProblem ? `${parent.path.replace(/[\\/]+$/u, "")}${separator}${name}` : null;
  const shownDestination = destination ? displayFolderPath(destination) : "";

  async function create () {
    if (!mounted || !parent || !destination || creating) return;
    setCreating(true);
    setError("");
    setStatus("");
    try {
      const result = await mounted.workspace.daemon({ kind: "installation", daemonId: parent.daemonId })
        .projectCreation.create({ parentPath: parent.path, name, template });
      if (!active.current) return;
      if (!result.accepted) {
        setError(REJECTION_MESSAGES[result.reason]);
        return;
      }
      const snapshot = await mounted.refreshInstallationProjects(parent.daemonId);
      if (!active.current) return;
      const logicalProjectId = result.projectId ? snapshot.locations.find(item =>
        item.target.daemonId === parent.daemonId && item.target.projectId === result.projectId)?.logicalProjectId : undefined;
      if (!logicalProjectId) {
        setStatus(`Created ${displayFolderPath(result.path)}. It will appear in projects once discovery finds it.`);
        return;
      }
      const selected = [...new Set([...(route.selectedProjectIds ?? []), logicalProjectId])];
      navigateToRoute(selected.length === 1
        ? createLogicalProjectRoute(logicalProjectId)
        : createProjectSelectionRoute(selected));
    } catch (failure) {
      if (active.current) setError((failure instanceof Error ? failure.message : "Unable to create the project.").slice(0, 500));
    } finally {
      if (active.current) setCreating(false);
    }
  }

  return (
    <form
      className="mx-auto flex w-full max-w-content flex-col px-5 pt-1 text-text"
      onSubmit={event => { event.preventDefault(); void create(); }}
    >
      <FormSection title="Location" description="Choose a folder inside one of your project roots. Double-click a folder to open it.">
        <WorkbenchFolderPicker dispatch={dispatch} state={picker} />
      </FormSection>
      <FormSection title="Template" description="Starter files written before the repository is initialised.">
        <div className="py-1">
          <WorkbenchSettingsContextRow
            label="Template"
            value={template}
            options={TEMPLATES}
            onSelect={id => { const next = TEMPLATES.find(item => item.id === id); if (next) setTemplate(next.id); }}
          />
        </div>
      </FormSection>
      <FormSection title={<label htmlFor={nameId}>Name</label>} description="The new project's folder name.">
        <WorkbenchTextField
          id={nameId}
          className="w-full"
          autoComplete="off"
          spellCheck={false}
          value={name}
          aria-invalid={Boolean(nameProblem)}
          aria-describedby={nameProblem ? `${nameId}-issue` : undefined}
          onChange={event => { setName(event.target.value); setError(""); setStatus(""); }}
          placeholder="my-project"
        />
        {nameProblem ? <p id={`${nameId}-issue`} role="alert" className="m-0 pt-1 text-[0.8rem] text-danger">{nameProblem}</p> : null}
      </FormSection>
      <div className="mt-6 flex items-center justify-between gap-3 pb-10 pt-3">
        <p
          role={error ? "alert" : "status"}
          title={error || status || shownDestination || undefined}
          className={`m-0 min-w-0 truncate ${error ? "text-danger" : "text-fg/muted"}`}
        >{error || status || shownDestination}</p>
        <PrimaryButton type="submit" className="shrink-0" disabled={!destination || creating} pendingHalo={creating}>
          Create project
        </PrimaryButton>
      </div>
    </form>
  );
}
