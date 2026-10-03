/*
 * Exports:
 * - default ThreadProfileEditor: profile customisation popup sharing authoritative profile settings.
 * - formatProfileContext: context cap label without losing 1K precision.
 * - profileContextColour: context slider colour through six ordered stops.
 * - profileEffortColour: faint-to-saturated accent for effort.
 */
"use client";
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import type { WorkbenchComposerProfileSlot, WorkbenchComposerSettings } from "workbench-shared/types";
import { getWorkbenchAgentPathLabel } from "workbench-shared/workbench/agent-paths";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { matchesWorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";
import { contextWindowFloor, copyComposerSettings } from "workbench-shared/workbench/thread/thread-profile";
import { groupWorkbenchModels, type WorkbenchGroupedModel } from "../workbench-model-groups";
import ChevronIcon from "../ChevronIcon";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";
import { ReloadIcon, ZapIcon } from "../workbench-icons";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";
import WorkbenchIconButton from "../WorkbenchIconButton";
import WorkbenchPopover from "../WorkbenchPopover";
import WorkbenchPressDragSlider from "../WorkbenchPressDragSlider";
import { formatHarnessLabel } from "./harness-label";
import ThreadAgentPicker from "./ThreadAgentPicker";
import ThreadComposerPickerHeader from "./ThreadComposerPickerHeader";
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
  anchor, trigger, controller, slot, fallbackSettings, onCustomChange, onRefreshModels, onRefreshAgents,
}: {
  anchor: HTMLElement;
  trigger: HTMLElement;
  controller: ThreadProfileEditorController;
  slot: WorkbenchComposerProfileSlot;
  fallbackSettings: WorkbenchComposerSettings;
  onCustomChange: (settings: WorkbenchComposerSettings) => void;
  onRefreshModels: (harness: WorkbenchComposerSettings["harness"]) => void;
  onRefreshAgents: () => void;
}) {
  const profiles = useWorkbenchComposerProfiles();
  const clientStateController = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const [favouriteError, setFavouriteError] = useState("");
  const sectionId = useId();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const profile = profiles.controller.getSelectedProfile(slot);
  const settings = profile ? copyComposerSettings(profile) : profiles.controller.resolveSettings(slot) ?? fallbackSettings;
  const favourites = clientState.records.flatMap(record =>
    record.kind === "modelPreference" && record.favourite
      ? [{ harness: record.harness, modelId: record.modelId }] : []);
  const favouriteKeys = new Set(favourites.map(item => `${item.harness}\0${item.modelId}`));
  const allowedHarnesses = slot.kind === "thread" ? [settings.harness] : [...installedProviderKeys];
  const groups = groupWorkbenchModels({
    catalogues: state.modelsByHarness,
    favourites,
    allowedHarnesses,
    now: Date.now(),
  });
  const canSaveFavourites = clientState.schemaVersion >= 7;
  const toggleFavourite = async ({ harness, model }: WorkbenchGroupedModel) => {
    if (!canSaveFavourites) return;
    setFavouriteError("");
    try {
      const savedIds = [model.id, ...(model.aliases ?? [])]
        .filter(id => favouriteKeys.has(`${harness}\0${id}`));
      if (savedIds.length) {
        await Promise.all(savedIds.map(modelId =>
          clientStateController.delete({ kind: "modelPreference", harness, modelId })));
      } else {
        await clientStateController.put({ kind: "modelPreference", harness, modelId: model.id, favourite: true });
      }
    } catch {
      console.warn("Unable to save model favourite preference.");
      setFavouriteError("Unable to save model favourite. Please try again.");
    }
  };
  const visibleModels = state.modelsByHarness[settings.harness] ?? [];
  const model = visibleModels.find((entry) => matchesWorkbenchModelOption(entry, settings.model));
  const modelError = state.modelsErrorByHarness[settings.harness] ?? "";
  const modelsLoading = Boolean(state.modelsLoadingByHarness[settings.harness])
    || !state.modelsByHarness[settings.harness] && !modelError;
  const efforts = model?.supportedReasoningEfforts ?? [];
  const capability = model?.contextWindow;
  const showsEffort = Boolean(model?.supportsReasoningEffort && efforts.length);
  const showsFastMode = Boolean(model?.supportsFastMode);
  const update = (changes: Partial<WorkbenchComposerSettings>) => {
    if (profile) void profiles.controller.updateProfile(profile.id, changes);
    else onCustomChange({ ...settings, ...changes });
  };
  const block = (section: ProfileEditorSection, title: string, value: ReactNode, content: ReactNode) => {
    const active = state.activeSection === section;
    return <section key={section} className={`
      grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden
      ${active ? "flex-1" : ""}
      ${section === "profile" ? "md:hidden" : ""}
    `}>
      <button
        type="button"
        id={`${sectionId}-${section}-summary`}
        aria-expanded={active}
        aria-controls={`${sectionId}-${section}-content`}
        className={`
          enabled:cursor-pointer flex min-w-0 items-center gap-2 px-4 py-1.5 text-left text-sm text-fg/muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft
          ${active ? "border-b border-fg/10" : ""}
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
        className={`min-h-0 scrollbar-hover-reveal overflow-y-auto overscroll-contain px-4 py-3 border-b border-fg/10 bg-fg/0.5`}
      >{content}</div>
    </section>;
  };
  const refresh = state.activeSection === "model"
    ? { label: "Refresh models", loading: allowedHarnesses.some(harness => state.modelsLoadingByHarness[harness]), run: () => allowedHarnesses.forEach(onRefreshModels) }
    : state.activeSection === "agent"
      ? { label: "Refresh agents", loading: state.agentsLoading, run: onRefreshAgents }
      : null;
  return <WorkbenchPopover anchor={anchor} trigger={trigger} label="Profile customisation" onClose={controller.close} width={780}>
    <div className="row-span-2 grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[minmax(0,330px)_minmax(0,1fr)]">
      <header className="min-w-0 px-4 py-3 col-span-full row-1 border-b border-fg/10 bg-alpha/30">
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
      <aside aria-label="Profiles" className="hidden min-h-0 min-w-0 scrollbar-hover-reveal overflow-y-auto overscroll-contain border-r border-fg/10 bg-fg/3 pl-4 pr-2 py-3 md:col-start-1 md:block">
        <h2 className="m-0 text-sm font-semibold text-fg/muted">Profiles</h2>
        <ThreadProfilePicker
          agents={state.agents} currentSettings={settings} models={visibleModels} projectId={slot.projectId} slot={slot}
        />
      </aside>
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-hidden pb-2 md:col-start-2 md:row-start-2 bg-alpha/50"
      >
        {block("profile", "Profile", profile?.name || (profile ? profile.model : "Custom"), <ThreadProfilePicker
          agents={state.agents} currentSettings={settings} models={visibleModels} projectId={slot.projectId} slot={slot}
        />)}
        {block("model", "Model", `${formatHarnessLabel(settings.harness)} · ${modelsLoading ? "Loading..." : modelError ? "Unavailable" : model?.displayName ?? settings.model}`, <div className="flex h-full min-h-0 flex-col gap-2">
          {!canSaveFavourites ? <p className="text-xs text-fg/muted">Reload the app database to enable saving model favourites.</p> : null}
          {favouriteError ? <p role="alert" className="text-sm text-danger">{favouriteError}</p> : null}
          <div className="min-h-0 flex-1"><ThreadModelPicker
            appliesOnNextTurnOnly={slot.kind === "thread"} favouriteKeys={favouriteKeys}
            favouritesDisabled={!canSaveFavourites}
            groups={groups} loadingByHarness={state.modelsLoadingByHarness} errorByHarness={state.modelsErrorByHarness}
            selectedHarness={settings.harness} selectedModelId={settings.model}
            onToggleFavourite={(entry) => { void toggleFavourite(entry); }}
            onSelectModel={({ harness, model: selected }) => update({
              harness,
              model: selected.id,
              reasoningEffort: selected.supportsReasoningEffort ? selected.defaultReasoningEffort ?? selected.supportedReasoningEfforts[0] ?? null : null,
              serviceTier: harness === settings.harness && selected.supportsFastMode ? settings.serviceTier : null,
              contextWindowTokens: selected.contextWindow?.defaultTokens ?? null,
            })}
          /></div>
        </div>)}
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
            className="row-span-2 self-center ml-auto text-text"
            onClick={() => update({ serviceTier: settings.serviceTier === "fast" ? null : "fast" })}
          ><ZapIcon size={16} className={settings.serviceTier === "fast" ? "fill-current" : undefined} /></WorkbenchIconButton> : null}
          {capability ? <div className="grid grid-cols-subgrid col-span-3 min-w-0 items-center gap-3 px-4 py-0.5 text-sm">
            <span className="text-fg/muted">Context</span>
            <WorkbenchPressDragSlider presentation="inline" subgrid={true} key={`${settings.harness}:${settings.model}:context`} label="Context window" min={contextWindowFloor(capability)} max={capability.maximumTokens} step={1000} value={settings.contextWindowTokens ?? capability.defaultTokens} format={formatProfileContext} colour={profileContextColour} onChange={(contextWindowTokens) => update({ contextWindowTokens })} />
          </div> : null}
        </div> : null}
        {block("agent", "Agent definition", state.agents.find((entry) => entry.path === settings.agentPath)?.name ?? getWorkbenchAgentPathLabel(settings.agentPath) ?? "Default agent", <ThreadAgentPicker
          agents={state.agents} error={state.agentsError} isLoading={state.agentsLoading}
          selectedAgentPath={settings.agentPath}
          onSelectAgent={(agentPath) => update({ agentPath, agentSource: state.agents.find((agent) => agent.path === agentPath)?.source ?? null })}
        />)}
      </div>
    </div>
  </WorkbenchPopover>;
}
