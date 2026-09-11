/*
 * Exports:
 * - default ThreadProfilePicker: profile cards containing selection, editing, scope and deletion.
 */
"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { WorkbenchAgentOption, WorkbenchComposerProfile, WorkbenchComposerProfileSlot, WorkbenchComposerSettings, WorkbenchModelOption } from "workbench-shared/types";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";
import { BinIcon, SparkleIcon } from "../workbench-icons";
import WorkbenchIconButton from "../WorkbenchIconButton";
import PlaintextEditable from "./PlaintextEditable";
import { WorkbenchOptionCard } from "../WorkbenchOptionCards";
import ThreadPickerGroupMoveButton from "./ThreadPickerGroupMoveButton";
import { getComposerProfileDisplayLabel } from "./composer-profile-label";

function ProfileNameEditable({ fallback, name, onCommit }: { fallback: string; name: string; onCommit: (name: string) => void }) {
  const editableRef = useRef<HTMLSpanElement>(null);
  const [hasText, setHasText] = useState(Boolean(name));

  useEffect(() => {
    const editable = editableRef.current;
    if (!editable || document.activeElement === editable) return;
    if ((editable.textContent ?? "") !== name) editable.textContent = name;
    setHasText(Boolean(name));
  }, [name]);

  const commit = () => {
    const value = (editableRef.current?.textContent ?? "").trim();
    if (editableRef.current && editableRef.current.textContent !== value) editableRef.current.textContent = value;
    setHasText(Boolean(value));
    if (value !== name) onCommit(value);
  };

  return <span className="relative inline-grid min-w-[8ch] max-w-full">
    {!hasText ? <span aria-hidden="true" className="pointer-events-none col-start-1 row-start-1 whitespace-nowrap text-[0.96em] font-semibold text-muted">{fallback}</span> : null}
    <span ref={editableRef} aria-label="Profile name" contentEditable="plaintext-only" suppressContentEditableWarning role="textbox" className="relative col-start-1 row-start-1 inline-block min-w-[8ch] max-w-full overflow-hidden whitespace-nowrap text-[0.96em] font-semibold text-text outline-none" onBlur={commit} onClick={(event) => event.stopPropagation()} onInput={(event) => setHasText(Boolean(event.currentTarget.textContent))} onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}>{name}</span>
  </span>;
}

function normalizeProfileDescription(value: string) {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function ProfileDescriptionEditable({ description = "", onCommit }: { description?: string; onCommit: (description: string | undefined) => void }) {
  const [draft, setDraft] = useState(description);

  useEffect(() => {
    setDraft(description);
  }, [description]);

  const commit = (value: string) => {
    const normalized = normalizeProfileDescription(value);
    setDraft(normalized);
    if (normalized !== description) onCommit(normalized || undefined);
  };

  return <div>
    <PlaintextEditable
      ariaLabel="Profile description"
      className="min-h-[1.45rem] whitespace-pre-wrap break-words text-[0.78em] leading-[1.6] text-muted outline-none before:pointer-events-none before:text-muted/60 data-[empty=true]:before:content-[attr(data-placeholder)]"
      onBlur={(event) => commit(event.currentTarget.innerText)}
      onChange={setDraft}
      placeholder="Describe when this profile should be used as a subagent…"
      spellCheck
      value={draft}
    />
  </div>;
}

export default function ThreadProfilePicker({ agents, currentSettings, models, projectId, slot }: {
  agents: WorkbenchAgentOption[]; currentSettings: WorkbenchComposerSettings;
  models: WorkbenchModelOption[];
  projectId: string; slot: WorkbenchComposerProfileSlot;
}) {
  const { controller, snapshot } = useWorkbenchComposerProfiles();
  const selection = controller.getSelection(slot);
  const selectedProfile = selection.kind === "profile" ? controller.getProfile(selection.profileId) : null;
  const visible = controller.getVisibleProfiles(projectId, slot.kind !== "new-thread" ? slot.harness : null);
  const profiles = selectedProfile && !visible.some(({ id }) => id === selectedProfile.id) ? [selectedProfile, ...visible] : visible;
  const globals = profiles.filter(({ scope }) => scope.kind === "global");
  const projects = profiles.filter(({ scope }) => scope.kind === "project");
  void snapshot;

  const renderProfile = (profile: WorkbenchComposerProfile) => {
    const model = models.find(({ id }) => id === profile.model) ?? null;
    const agent = agents.find(({ path }) => path === profile.agentPath) ?? null;
    const label = getComposerProfileDisplayLabel(profile, agent?.name, model?.displayName);
    const active = selection.kind === "profile" && selection.profileId === profile.id;
    return <WorkbenchOptionCard
      key={profile.id}
      density="tight"
      isChecked={active}
      label={label}
      onClick={() => controller.selectProfile(slot, profile.id)}
      labelEditor={active ? <ProfileNameEditable fallback={label} name={profile.name} onCommit={(name) => { void controller.updateProfile(profile.id, { name }); }} /> : undefined}
      actions={<>
          <ThreadPickerGroupMoveButton direction={profile.scope.kind === "global" ? "down" : "up"} disabled={profile.scope.kind === "project" && profile.agentSource === "project"} label={profile.scope.kind === "global" ? `Move ${label} to this project` : `Promote ${label} globally`} onClick={() => { void controller.updateProfile(profile.id, { scope: profile.scope.kind === "global" ? { kind: "project", projectId } : { kind: "global" } }); }} />
          <WorkbenchIconButton size="small" tone="danger" label={`Remove ${label}`} onClick={() => { void controller.deleteProfile(profile.id); }}><BinIcon className="size-4" /></WorkbenchIconButton>
      </>}
      description={!active ? profile.description : undefined}
    >
      {active ? <ProfileDescriptionEditable description={profile.description} onCommit={(description) => { void controller.updateProfile(profile.id, { description }); }} /> : null}
    </WorkbenchOptionCard>;
  };

  return <section aria-label="Composer profiles">
    <div role="group" aria-label="Composer profiles" className="mt-1 grid gap-2">
      <WorkbenchOptionCard density="tight" isChecked={selection.kind === "custom"} label="Custom" onClick={() => { void controller.selectCustom(slot, currentSettings); }} />
      <p className="mt-2 mb-0 px-1 text-[0.78em] font-semibold uppercase tracking-[0.12em] text-muted">Global</p>{globals.map(renderProfile)}
      <p className="mt-2 mb-0 px-1 text-[0.78em] font-semibold uppercase tracking-[0.12em] text-muted">Project</p>{projects.map(renderProfile)}
    </div>
    <div className="mt-4 flex items-center justify-end gap-2 text-[0.78em] text-muted">
      <button type="button" disabled={!currentSettings.model} aria-label="Create profile" title="Create profile" className="inline-flex items-center gap-2 rounded-md px-2 py-1 hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] disabled:cursor-not-allowed disabled:opacity-40" onClick={() => {
        void controller.createProfile({ ...currentSettings, name: "", scope: { kind: "project", projectId } }).then((profile) => {
          if (profile) controller.selectProfile(slot, profile.id);
        });
      }}><SparkleIcon /><span>New</span></button>
    </div>
  </section>;
}
