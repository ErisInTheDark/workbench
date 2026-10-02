/*
 * Exports:
 * - default CommandApprovalSettings: edit exact-workdir command permissions with authoritative daemon saves.
 */
"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ProjectFolderOption } from "workbench-shared/workbench/project/project-folder-address";
import type { CommandApprovalRule } from "workbench-shared/workbench/settings/command-approvals";
import CommandApprovalSettingsController from "../../workbench/CommandApprovalSettingsController";
import InputList from "./InputList";
import { InputListRows, type InputListRow } from "./input-list-rows";
import { ResetIcon, SaveIcon } from "./workbench-icons";
import WorkbenchIconButton from "./WorkbenchIconButton";
import WorkbenchSettingsContextRow from "./WorkbenchSettingsContextRow";
import { useWorkbenchDaemonClient } from "./WorkbenchWorkspaceContext";

function prefixText(rule: CommandApprovalRule) {
  return rule.prefix.map(token => /\s/u.test(token) ? JSON.stringify(token) : token).join(" ");
}
function rowsFor(rules: readonly CommandApprovalRule[]): InputListRow[] {
  return InputListRows.create(rules.map(rule => ({ id: rule.id, value: prefixText(rule) })));
}
function workdirKey(value: string) {
  const slash = value.replace(/\\/gu, "/").replace(/\/+$/gu, "") || "/";
  return /^[A-Za-z]:\//u.test(slash) || slash.startsWith("//") ? slash.toLocaleLowerCase() : slash;
}
function isWithin(root: string, path: string) {
  const base = workdirKey(root);
  const candidate = workdirKey(path);
  return candidate === base || candidate.startsWith(`${base}/`);
}

export default function CommandApprovalSettings({
  folders,
  projectId,
}: {
  folders: readonly ProjectFolderOption[];
  projectId: string;
}) {
  const [selectedKey, setSelectedKey] = useState("");
  const selected = folders.find(item => `${item.target.daemonId}/${item.target.projectId}` === selectedKey)
    ?? folders.find(item => item.target.projectId === projectId) ?? folders[0] ?? null;
  if (!selected) return null;
  return <div className="space-y-3 py-3">
    <h3 className="m-0 text-sm font-semibold text-text">Command prefixes allowed outside sandbox</h3>
    <WorkbenchSettingsContextRow label="Folder"
      value={`${selected.target.daemonId}/${selected.target.projectId}`}
      options={folders.map(item => ({
        id: `${item.target.daemonId}/${item.target.projectId}`,
        label: item.displayPath ?? `${item.hostname}:${item.rootPath}`,
      }))}
      onSelect={setSelectedKey} />
    <ApprovalEditor key={`${selected.target.daemonId}/${selected.target.projectId}`}
      projectId={selected.target.projectId} rootPath={selected.rootPath} />
  </div>;
}

function ApprovalEditor({ projectId, rootPath }: { projectId: string; rootPath: string }) {
  const daemon = useWorkbenchDaemonClient();
  const controller = useMemo(() => new CommandApprovalSettingsController({
    read: () => daemon.commandApprovals.read({ projectId }),
    patch: (workdir, add, removeIds) => daemon.commandApprovals.patch({ projectId, workdir, add, removeIds }),
  }), [daemon, projectId]);
  useEffect(() => {
    void controller.refresh();
    return () => controller.dispose();
  }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [selectedWorkdir, setSelectedWorkdir] = useState(rootPath);
  const workdirs = [rootPath, ...new Set(state.rules.map(rule => rule.workdir)
    .filter(path => isWithin(rootPath, path) && workdirKey(path) !== workdirKey(rootPath)))];
  const workdir = workdirs.includes(selectedWorkdir) ? selectedWorkdir : rootPath;
  const saved = state.rules.filter(rule => workdirKey(rule.workdir) === workdirKey(workdir));
  const [rows, setRows] = useState<InputListRow[]>(() => rowsFor([]));
  useEffect(() => { setRows(rowsFor(saved)); }, [state.rules, workdir]);
  const byId = new Map(saved.map(rule => [rule.id, prefixText(rule)]));
  const filled = rows.map(row => ({ ...row, value: row.value.trim() })).filter(row => row.value);
  const add = filled.filter(row => byId.get(row.id) !== row.value).map(row => row.value);
  const removeIds = saved.filter(rule => !filled.some(row => row.id === rule.id && row.value === byId.get(rule.id)))
    .map(rule => rule.id);
  const dirty = add.length > 0 || removeIds.length > 0;
  return <>
    {workdirs.length > 1 ? <WorkbenchSettingsContextRow label="Workdir" value={workdir}
      options={workdirs.map(path => ({ id: path, label: path }))}
      onSelect={setSelectedWorkdir} /> : null}
    <InputList idPrefix="command-prefix" placeholder="Command prefix" rowLabel="Command prefix"
      disabled={state.loading} rows={rows} onRowsChange={setRows} />
    <div className="flex items-center gap-2">
      <WorkbenchIconButton type="button" label="Save command prefixes" disabled={!dirty || state.loading}
        onClick={() => { void controller.save(workdir, add, removeIds); }}>
        <SaveIcon size={16} />
      </WorkbenchIconButton>
      <WorkbenchIconButton type="button" label="Reset command prefix changes" disabled={!dirty || state.loading}
        onClick={() => setRows(rowsFor(saved))}>
        <ResetIcon size={16} />
      </WorkbenchIconButton>
    </div>
    {state.loading ? <p role="status" className="m-0 text-xs text-fg/muted">Loading approvals...</p> : null}
    {state.error ? <p role="alert" className="m-0 text-xs text-danger">{state.error}</p> : null}
  </>;
}
