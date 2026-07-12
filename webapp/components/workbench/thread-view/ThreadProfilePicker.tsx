/*
 * Exports:
 * - default ThreadProfilePicker: select, create, rename, configure, scope, and remove inline composer profiles. Keywords: thread, composer, profile, picker, scope.
 * - Local helpers: normalize model-dependent settings and render inline profile groups. Keywords: profile, model, group.
 */
"use client";

import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { WorkbenchAgentOption, WorkbenchComposerProfile, WorkbenchComposerProfileSlot, WorkbenchComposerSettings, WorkbenchModelOption } from "../../../lib/types";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileProvider";
import { FileDeleteIcon, SparkleIcon } from "../workbench-icons";
import ThreadAgentPicker from "./ThreadAgentPicker";
import ThreadComposerPickerHeader from "./ThreadComposerPickerHeader";
import ThreadComposerRibbon from "./ThreadComposerRibbon";
import ThreadHarnessControl from "./ThreadHarnessControl";
import ThreadModelPicker from "./ThreadModelPicker";
import ThreadPickerGroupMoveButton from "./ThreadPickerGroupMoveButton";
import { getComposerProfileDisplayLabel } from "./composer-profile-label";

const iconButtonClassName = "inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] text-muted transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft";

function settingsFromModel(settings: WorkbenchComposerSettings, model: WorkbenchModelOption | null) {
  if (!model) return settings;
  const efforts = model.supportedReasoningEfforts;
  return { ...settings, reasoningEffort: model.supportsReasoningEffort ? (efforts.includes(settings.reasoningEffort ?? "") ? settings.reasoningEffort : model.defaultReasoningEffort ?? efforts[0] ?? null) : null, serviceTier: model.supportsFastMode ? settings.serviceTier : null };
}

export default function ThreadProfilePicker({ agents, agentsError, canToggleHarness, currentSettings, deprioritizedModelIds, isAgentRefreshDisabled, isAgentRefreshing, isLoadingAgents, isLoadingModels, isModelRefreshDisabled, isModelRefreshing, models, modelsError, onClose, onHarnessToggle, onLoadModels, onRefreshAgents, projectId, slot }: {
  agents: WorkbenchAgentOption[]; agentsError: string; canToggleHarness: boolean; currentSettings: WorkbenchComposerSettings; deprioritizedModelIds: string[];
  isAgentRefreshDisabled: boolean; isAgentRefreshing: boolean; isLoadingAgents: boolean; isLoadingModels: boolean; isModelRefreshDisabled: boolean; isModelRefreshing: boolean;
  models: WorkbenchModelOption[]; modelsError: string; onClose: () => void; onHarnessToggle?: () => void; onLoadModels: (harness: WorkbenchComposerSettings["harness"], forceRefresh?: boolean) => Promise<void>; onRefreshAgents: () => void;
  projectId: string; slot: WorkbenchComposerProfileSlot;
}) {
  const { controller, snapshot } = useWorkbenchComposerProfiles();
  const selection = controller.getSelection(slot);
  const selectedProfile = selection.kind === "profile" ? controller.getProfile(selection.profileId) : null;
  const visible = controller.getVisibleProfiles(projectId, slot.kind === "thread" ? slot.harness : null);
  const profiles = selectedProfile && !visible.some(({ id }) => id === selectedProfile.id) ? [selectedProfile, ...visible] : visible;
  const globals = profiles.filter(({ scope }) => scope.kind === "global");
  const projects = profiles.filter(({ scope }) => scope.kind === "project");
  const [target, setTarget] = useState<{ id: string; step: "agent" | "model" } | null>(null);
  const targetProfile = target ? controller.getProfile(target.id) : null;
  void snapshot;

  if (targetProfile && target?.step === "model") return <ThreadModelPicker appliesOnNextTurnOnly={false} deprioritizedModelIds={deprioritizedModelIds} error={modelsError} harness={targetProfile.harness} isLoading={isLoadingModels} isRefreshDisabled={isModelRefreshDisabled} isRefreshing={isModelRefreshing} models={models} selectedModelId={targetProfile.model} showsPriorityControls={false} onClose={() => setTarget(null)} onRefresh={() => { void onLoadModels(targetProfile.harness, true); }} onSelectModel={(model) => { controller.updateProfile(targetProfile.id, settingsFromModel({ ...targetProfile, model: model.id }, model)); setTarget(null); }} onToggleModelPriority={() => {}} />;
  if (targetProfile && target?.step === "agent") return <ThreadAgentPicker agents={agents} error={agentsError} isLoading={isLoadingAgents} isRefreshDisabled={isAgentRefreshDisabled} isRefreshing={isAgentRefreshing} selectedAgentPath={targetProfile.agentPath} onClose={() => setTarget(null)} onRefresh={onRefreshAgents} onSelectAgent={(agentPath) => { const agent = agents.find(({ path }) => path === agentPath); controller.updateProfile(targetProfile.id, { agentPath, agentSource: agent?.source ?? null }); setTarget(null); }} />;

  const renderProfile = (profile: WorkbenchComposerProfile) => {
    const model = models.find(({ id }) => id === profile.model) ?? null;
    const agent = agents.find(({ path }) => path === profile.agentPath) ?? null;
    const label = getComposerProfileDisplayLabel(profile, agent?.name, model?.displayName);
    const active = selection.kind === "profile" && selection.profileId === profile.id;
    const cycleEffort = (direction: 1 | -1) => { const efforts = model?.supportedReasoningEfforts ?? []; if (!efforts.length) return; const index = efforts.indexOf(profile.reasoningEffort ?? ""); controller.updateProfile(profile.id, { reasoningEffort: efforts[((index < 0 ? 0 : index) + direction + efforts.length) % efforts.length] ?? null }); };
    const selectFromRow = (event: MouseEvent<HTMLElement>) => { if (!(event.target instanceof HTMLElement) || event.target.closest("button,[contenteditable='plaintext-only']")) return; controller.selectProfile(slot, profile.id); };
    return <article key={profile.id} role="radio" aria-checked={active} tabIndex={0} className={`rounded-[1rem] border px-4 py-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft ${active ? "border-text bg-[color-mix(in_srgb,var(--text)_6%,transparent)]" : "border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_98%,transparent)]"}`} onClick={selectFromRow} onKeyDown={(event) => { if (event.key === " " && event.target === event.currentTarget) { event.preventDefault(); controller.selectProfile(slot, profile.id); } }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative inline-grid min-w-[8ch] max-w-full">
          {!profile.name ? <span aria-hidden="true" className="pointer-events-none col-start-1 row-start-1 whitespace-nowrap text-[0.96em] font-semibold text-muted">{label}</span> : null}
          <span aria-label="Profile name" contentEditable="plaintext-only" suppressContentEditableWarning role="textbox" className="relative col-start-1 row-start-1 inline-block min-w-[8ch] max-w-full overflow-hidden whitespace-nowrap text-[0.96em] font-semibold text-text outline-none" onClick={(event) => event.stopPropagation()} onInput={(event) => controller.updateProfile(profile.id, { name: event.currentTarget.textContent ?? "" })} onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}>{profile.name}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <ThreadPickerGroupMoveButton direction={profile.scope.kind === "global" ? "down" : "up"} disabled={profile.scope.kind === "project" && profile.agentSource === "project"} label={profile.scope.kind === "global" ? `Move ${label} to this project` : `Promote ${label} globally`} onClick={() => controller.updateProfile(profile.id, { scope: profile.scope.kind === "global" ? { kind: "project", projectId } : { kind: "global" } })} />
          <button type="button" aria-label={`Remove ${label}`} title={`Remove ${label}`} className={`${iconButtonClassName} hover:!text-danger`} onClick={(event) => { event.stopPropagation(); controller.deleteProfile(profile.id); }}><FileDeleteIcon /></button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-muted">
        <span className="text-[0.78em]"><ThreadHarnessControl harness={profile.harness} /></span>
        <ThreadComposerRibbon agentLabel={agent?.name ?? (profile.agentPath || "Default agent")} currentReasoningEffort={profile.reasoningEffort} isFastModeEnabled={profile.serviceTier === "fast"} isProfilePanelOpen={false} modelLabel={model?.displayName ?? profile.model} profileLabel="" showsFastModeControl={profile.harness === "codex" && Boolean(model?.supportsFastMode)} showsProfileControl={false} showsReasoningEffortControl={Boolean(model?.supportsReasoningEffort && profile.reasoningEffort)} onAgentOpen={() => setTarget({ id: profile.id, step: "agent" })} onFastModeToggle={() => controller.updateProfile(profile.id, { serviceTier: profile.serviceTier === "fast" ? null : "fast" })} onModelOpen={() => { setTarget({ id: profile.id, step: "model" }); void onLoadModels(profile.harness); }} onProfileOpen={() => {}} onReasoningEffortCycle={cycleEffort} />
      </div>
    </article>;
  };

  return <section aria-label="Composer profiles">
    <ThreadComposerPickerHeader onClose={onClose} title="Choose a profile" />
    <div role="radiogroup" aria-label="Composer profiles" className="mt-3 grid gap-3">
      <button type="button" role="radio" aria-checked={selection.kind === "custom"} className={`rounded-[1rem] border px-4 py-3 text-left transition ${selection.kind === "custom" ? "border-text bg-[color-mix(in_srgb,var(--text)_6%,transparent)]" : "border-[color-mix(in_srgb,var(--text)_10%,transparent)]"}`} onClick={() => controller.selectCustom(slot, currentSettings)}><span className="block font-semibold text-text">Custom</span><span className="mt-1 block text-[0.78em] leading-[1.6] text-muted">Use independent ribbon settings for this composer.</span></button>
      <p className="mt-2 mb-0 px-1 text-[0.78em] font-semibold uppercase tracking-[0.12em] text-muted">Global</p>{globals.map(renderProfile)}
      <p className="mt-2 mb-0 px-1 text-[0.78em] font-semibold uppercase tracking-[0.12em] text-muted">Project</p>{projects.map(renderProfile)}
    </div>
    <div className="mt-4 flex items-center justify-end gap-2 text-[0.78em] text-muted">
      <ThreadHarnessControl canToggle={canToggleHarness} harness={currentSettings.harness} onToggle={onHarnessToggle} />
      <button type="button" disabled={!currentSettings.model} aria-label="Create profile" title="Create profile" className={`${iconButtonClassName} size-9 disabled:cursor-not-allowed disabled:opacity-40`} onClick={() => { const profile = controller.createProfile({ ...currentSettings, name: "", scope: { kind: "project", projectId } }); controller.selectProfile(slot, profile.id); }}><SparkleIcon /></button>
    </div>
  </section>;
}
