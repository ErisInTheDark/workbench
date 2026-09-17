/*
 * Exports:
 * - default ThreadProfileEditor: profile customisation popup sharing authoritative profile settings.
 * - formatProfileContext: context cap label without losing 1K precision.
 * - profileContextColour: context slider colour through six ordered stops.
 * - profileEffortColour: faint-to-saturated accent for effort.
 */
"use client";
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type { WorkbenchComposerSettings } from "workbench-shared/types";
import type { ComposerProfileTarget as WorkbenchComposerProfileSlot } from "../../../workbench/state/composer-profile-target";
import { getWorkbenchAgentPathLabel } from "workbench-shared/workbench/agent-paths";
import { copyComposerSettings } from "workbench-shared/workbench/thread/thread-profile";
import ChevronIcon from "../ChevronIcon";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";
import { ReloadIcon, ZapIcon } from "../workbench-icons";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";
import WorkbenchIconButton from "../WorkbenchIconButton";
import { WorkbenchOptionCard } from "../WorkbenchOptionCards";
import WorkbenchPopover from "../WorkbenchPopover";
import WorkbenchPressDragSlider from "../WorkbenchPressDragSlider";
import ThreadAgentPicker from "./ThreadAgentPicker";
import ThreadComposerPickerHeader from "./ThreadComposerPickerHeader";
import ThreadHarnessControl from "./ThreadHarnessControl";
import ThreadModelPicker from "./ThreadModelPicker";
import type ThreadProfileEditorController from "./ThreadProfileEditorController";
import type { ProfileEditorSection } from "./ThreadProfileEditorController";
import ThreadProfilePicker from "./ThreadProfilePicker";

export function formatProfileContext (tokens: number) {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(3))}M` : `${Math.round(tokens / 1000)}K`;
}
export function profileEffortColour (fraction: number) {
  return `color-mix(in srgb,var(--accent) ${20 + fraction * 80}%,transparent)`;
}
export function profileContextColour (fraction: number) {
  const stops = ["#3b82f6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#9ca3af"];
  const position = Math.max(0, Math.min(1, fraction)) * (stops.length - 1);
  const index = Math.floor(position);
  return `color-mix(in srgb,${stops[index]} ${(1 - (position - index)) * 100}%,${stops[Math.min(index + 1, stops.length - 1)]})`;
}

export default function ThreadProfileEditor ({
  anchor, trigger, controller, slot, fallbackSettings, onCustomChange, onRefreshModels, onRefreshAgents, onHarnessToggle, onHarnessSelect, canToggleHarness,
}: {
  anchor: HTMLElement;
  trigger: HTMLElement;
  controller: ThreadProfileEditorController;
  slot: WorkbenchComposerProfileSlot;
  fallbackSettings: WorkbenchComposerSettings;
  onCustomChange: (settings: WorkbenchComposerSettings) => void;
  onRefreshModels: () => void;
  onRefreshAgents: () => void;
  onHarnessToggle?: () => void;
  onHarnessSelect?: (harness: WorkbenchComposerSettings["harness"]) => void;
  canToggleHarness: boolean;
}) {
  const profiles = useWorkbenchComposerProfiles();
  const clientStateController = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const [favouriteError, setFavouriteError] = useState("");
  const sectionId = useId();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const profile = profiles.controller.getSelectedProfile(slot);
  const settings = profile ? copyComposerSettings(profile) : profiles.controller.resolveSettings(slot) ?? fallbackSettings;
  const unfavouritedModelIds = clientState.records.flatMap(record =>
    record.kind === "modelPreference" && record.harness === settings.harness && !record.favourite ? [record.modelId] : []);
  const canSaveFavourites = clientState.schemaVersion >= 7;
  const toggleFavourite = async (modelId: string) => {
    if (!canSaveFavourites) return;
    setFavouriteError("");
    try {
      await clientStateController.put({
        kind: "modelPreference", harness: settings.harness, modelId, favourite: unfavouritedModelIds.includes(modelId),
      });
    } catch {
      console.warn("Unable to save model favourite preference.");
      setFavouriteError("Unable to save model favourite. Please try again.");
    }
  };
  const model = state.models.find((entry) => entry.id === settings.model);
  const efforts = slot.kind === "voice" ? [...new Set(["none", ...model?.supportedReasoningEfforts ?? []])] : model?.supportedReasoningEfforts ?? [];
  const capability = model?.contextWindow;
  const showsEffort = slot.kind === "voice" || Boolean(model?.supportsReasoningEffort && efforts.length);
  const showsFastMode = Boolean(model?.supportsFastMode);
  const update = (changes: Partial<WorkbenchComposerSettings>) => {
    if (profile) void profiles.controller.updateProfile(profile.id, changes);
    else onCustomChange({ ...settings, ...changes });
  };
  const block = (section: ProfileEditorSection, title: string, value: ReactNode, content: ReactNode) => {
    const active = state.activeSection === section;
    return <section key={section} className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <button
        type="button"
        id={`${sectionId}-${section}-summary`}
        aria-expanded={active}
        aria-controls={`${sectionId}-${section}-content`}
        className={`
          enabled:cursor-pointer flex min-w-0 items-center gap-2 px-4 py-1.5 text-left text-sm text-fg/muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft
          ${active ? "border-b border-[color-mix(in_srgb,var(--text)_10%,transparent)]" : ""}
        `}
        onClick={() => controller.disclose(section, !active)}
      >
        <ChevronIcon className={`shrink-0 transition-transform ${active ? "" : "-rotate-90"}`} size={16} />
        <span className="shrink-0">{title}</span>
        <span className={`
          ml-auto truncate text-text
          ${section === "profile" || section === "model" || section === "agent" ? "font-semibold" : ""}
        `}>{value}</span>
      </button>
      <div
        id={`${sectionId}-${section}-content`}
        role="region"
        aria-labelledby={`${sectionId}-${section}-summary`}
        hidden={!active}
        className="min-h-0 overflow-y-auto overscroll-contain px-4 py-3 border-b border-[color-mix(in_srgb,var(--text)_10%,transparent)]"
      >{content}</div>
    </section>;
  };
  const refresh = state.activeSection === "model"
    ? { label: "Refresh models", loading: state.modelsLoading, run: onRefreshModels }
    : state.activeSection === "agent"
      ? { label: "Refresh agents", loading: state.agentsLoading, run: onRefreshAgents }
      : null;
  const rows = ["profile", "harness", "model", ...(showsEffort || showsFastMode ? ["effort"] : []), ...(capability ? ["context"] : []), "agent"];

  return <WorkbenchPopover anchor={anchor} trigger={trigger} label="Profile customisation" onClose={controller.close}>
    <header className="min-w-0 px-4 py-3">
      <ThreadComposerPickerHeader
        title="Profile customisation"
        closeLabel="Close profile customisation"
        onClose={controller.close}
        actions={refresh ? [{
          label: refresh.label,
          disabled: refresh.loading,
          icon: <span className={refresh.loading ? "inline-flex animate-spin [animation-direction:reverse]" : "inline-flex"}><ReloadIcon size={20} /></span>,
          onClick: refresh.run,
        }] : []}
      />
      {profiles.snapshot.error ? <p role="alert" className="m-0 pt-2 text-sm text-danger">{profiles.snapshot.error}</p> : null}
    </header>
    <div
      className="grid min-h-0 min-w-0 content-start overflow-hidden pb-2"
      style={{ gridTemplateRows: rows.map(row => row === state.activeSection ? "minmax(0,1fr)" : "auto").join(" ") }}
    >
      {block("profile", "Profile", profile?.name || (profile ? profile.model : "Custom"), <ThreadProfilePicker
        agents={state.agents} currentSettings={settings} models={state.models} projectId={slot.kind === "voice" ? null : slot.projectId} slot={slot}
      />)}
      {block("harness", "Provider", <ThreadHarnessControl harness={settings.harness} />, <div className="text-sm text-fg/muted">
        {!profile && canToggleHarness && slot.kind !== "thread"
          ? onHarnessSelect
            ? <div className="grid gap-2">{installedProviderKeys.map((harness) => <WorkbenchOptionCard key={harness} density="tight" label={<ThreadHarnessControl harness={harness} />} isChecked={harness === settings.harness} onClick={() => onHarnessSelect(harness)} />)}</div>
            : <button type="button" className="rounded-md px-2 py-1 hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)]" onClick={onHarnessToggle}>Change provider</button>
          : <p className="m-0">The provider is fixed for this {profile ? "stored profile" : "thread"}.</p>}
      </div>)}
      {block("model", "Model", model?.displayName ?? settings.model, <>
        {!canSaveFavourites ? <p className="text-xs text-fg/muted">Reload the app database to enable saving model favourites.</p> : null}
        {favouriteError ? <p role="alert" className="text-sm text-danger">{favouriteError}</p> : null}
        <ThreadModelPicker
          appliesOnNextTurnOnly={slot.kind === "thread"} unfavouritedModelIds={unfavouritedModelIds}
          favouritesDisabled={!canSaveFavourites}
          error={state.modelsError} harness={settings.harness} isLoading={state.modelsLoading}
          models={state.models} selectedModelId={settings.model}
          onToggleFavourite={(id) => { void toggleFavourite(id); }}
          onSelectModel={(selected) => update({
            model: selected.id,
            reasoningEffort: slot.kind === "voice" ? "none" : selected.supportsReasoningEffort ? selected.defaultReasoningEffort ?? selected.supportedReasoningEfforts[0] ?? null : null,
            serviceTier: selected.supportsFastMode ? settings.serviceTier : null,
            contextWindowTokens: selected.contextWindow?.defaultTokens ?? null,
          })}
        />
      </>)}
      {showsEffort || showsFastMode || capability ? <div className="grid [grid-template-columns:auto_1fr_auto_auto] pr-3">
        {showsEffort ? <div className="grid grid-cols-subgrid col-span-3 min-w-0 items-center gap-3 px-4 py-0.5 text-sm">
          <span className="text-fg/muted">Effort</span>
          <WorkbenchPressDragSlider presentation="inline" subgrid={true} key={`${settings.harness}:${settings.model}:effort`} label="Reasoning effort" min={0} max={efforts.length - 1} step={1} value={Math.max(0, efforts.indexOf(settings.reasoningEffort ?? ""))} valueText={settings.reasoningEffort ?? "Default"} valueOptions={["Default", ...efforts]} format={(index) => efforts[index] ?? ""} colour={profileEffortColour} onChange={(index) => update({ reasoningEffort: efforts[index] })} />
        </div> : null}
        {showsFastMode ? <WorkbenchIconButton
          size="small"
          label={settings.serviceTier === "fast" ? "Turn fast mode off" : "Turn fast mode on"}
          title={settings.serviceTier === "fast" ? "Fast mode is on" : "Fast mode is off"}
          aria-pressed={settings.serviceTier === "fast"}
          className={`row-span-2 self-center ml-auto ${settings.serviceTier === "fast" ? "text-text" : ""}`}
          onClick={() => update({ serviceTier: settings.serviceTier === "fast" ? null : "fast" })}
        ><ZapIcon size={16} /></WorkbenchIconButton> : null}
        {capability ? <div className="grid grid-cols-subgrid col-span-3 min-w-0 items-center gap-3 px-4 py-0.5 text-sm">
          <span className="text-fg/muted">Context</span>
          <WorkbenchPressDragSlider presentation="inline" subgrid={true} key={`${settings.harness}:${settings.model}:context`} label="Context window" min={capability.defaultTokens} max={capability.maximumTokens} step={1000} value={settings.contextWindowTokens ?? capability.defaultTokens} format={formatProfileContext} colour={profileContextColour} onChange={(contextWindowTokens) => update({ contextWindowTokens })} />
        </div> : null}
      </div> : null}
      {block("agent", "Agent definition", state.agents.find((entry) => entry.path === settings.agentPath)?.name ?? getWorkbenchAgentPathLabel(settings.agentPath) ?? "Default agent", <ThreadAgentPicker
        agents={state.agents} error={state.agentsError} isLoading={state.agentsLoading}
        selectedAgentPath={settings.agentPath}
        onSelectAgent={(agentPath) => update({ agentPath, agentSource: state.agents.find((agent) => agent.path === agentPath)?.source ?? null })}
      />)}
    </div>
  </WorkbenchPopover>;
}
