/*
 * Exports:
 * - default ThreadProfilePicker: select, create, edit, scope, and remove composer ribbon profiles using the shared composer-picker language. Keywords: thread, composer, profile, picker, scope.
 * - Local helpers: format profile scope, harness, model, and ribbon metadata for selectable profile cards. Keywords: profile, metadata, harness, model.
 */
"use client";

import { useEffect, useState } from "react";

import type {
  WorkbenchAgentOption,
  WorkbenchComposerProfile,
  WorkbenchComposerProfileSlot,
  WorkbenchComposerSettings,
  WorkbenchModelOption,
} from "../../../lib/types";
import PrimaryButton from "../PrimaryButton";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileProvider";
import {
  BackArrowIcon,
  FileDeleteIcon,
  FileUpdateIcon,
  SparkleIcon,
} from "../workbench-icons";
import ThreadAgentPicker from "./ThreadAgentPicker";
import ThreadComposerPickerHeader from "./ThreadComposerPickerHeader";
import ThreadComposerRibbon from "./ThreadComposerRibbon";
import ThreadModelPicker from "./ThreadModelPicker";

type ProfileEditorStep = "details" | "model" | "agent";

const pickerIconButtonClassName = "inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] text-muted transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45";

function formatHarnessLabel(harness: WorkbenchComposerSettings["harness"]) {
  switch (harness) {
    case "codex":
      return "Codex";
    case "copilot":
      return "Copilot";
    case "opencode":
      return "OpenCode";
  }
}

function profileScopeLabel(profile: WorkbenchComposerProfile, projectId: string) {
  if (profile.scope.kind === "global") {
    return "Global";
  }
  return profile.scope.projectId === projectId ? "This project" : "Linked elsewhere";
}

function settingsFromModel(settings: WorkbenchComposerSettings, model: WorkbenchModelOption | null) {
  if (!model) {
    return settings;
  }
  const supportedEfforts = model.supportedReasoningEfforts;
  const reasoningEffort = model.supportsReasoningEffort
    ? supportedEfforts.includes(settings.reasoningEffort ?? "")
      ? settings.reasoningEffort
      : model.defaultReasoningEffort ?? supportedEfforts[0] ?? null
    : null;
  return {
    ...settings,
    reasoningEffort,
    serviceTier: model.supportsFastMode ? settings.serviceTier : null,
  };
}

function profileSettings(profile: WorkbenchComposerProfile): WorkbenchComposerSettings {
  return {
    agentPath: profile.agentPath,
    agentSource: profile.agentSource,
    harness: profile.harness,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    serviceTier: profile.serviceTier,
  };
}

export default function ThreadProfilePicker({
  agents,
  agentsError,
  currentSettings,
  deprioritizedModelIds,
  isAgentRefreshDisabled,
  isAgentRefreshing,
  isLoadingAgents,
  isLoadingModels,
  isModelRefreshDisabled,
  isModelRefreshing,
  models,
  modelsError,
  onClose,
  onRefreshAgents,
  onRefreshModels,
  projectId,
  slot,
}: {
  agents: WorkbenchAgentOption[];
  agentsError: string;
  currentSettings: WorkbenchComposerSettings;
  deprioritizedModelIds: string[];
  isAgentRefreshDisabled: boolean;
  isAgentRefreshing: boolean;
  isLoadingAgents: boolean;
  isLoadingModels: boolean;
  isModelRefreshDisabled: boolean;
  isModelRefreshing: boolean;
  models: WorkbenchModelOption[];
  modelsError: string;
  onClose: () => void;
  onRefreshAgents: () => void;
  onRefreshModels: () => void;
  projectId: string;
  slot: WorkbenchComposerProfileSlot;
}) {
  const { controller, snapshot } = useWorkbenchComposerProfiles();
  const selection = controller.getSelection(slot);
  const selectedProfile = selection.kind === "profile" ? controller.getProfile(selection.profileId) : null;
  const visibleProfiles = controller.getVisibleProfiles(projectId, slot.kind === "thread" ? slot.harness : null);
  const profiles = selectedProfile && !visibleProfiles.some((profile) => profile.id === selectedProfile.id)
    ? [selectedProfile, ...visibleProfiles]
    : visibleProfiles;
  const sortedProfiles = [...profiles].sort((left, right) => (
    left.scope.kind === right.scope.kind
      ? left.name.localeCompare(right.name)
      : left.scope.kind === "global" ? -1 : 1
  ));
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editorStep, setEditorStep] = useState<ProfileEditorStep>("details");
  const [name, setName] = useState("");
  const [draftSettings, setDraftSettings] = useState<WorkbenchComposerSettings>(currentSettings);
  const [error, setError] = useState("");
  const editingProfile = editingProfileId ? controller.getProfile(editingProfileId) : null;
  const selectedModel = models.find((model) => model.id === draftSettings.model) ?? null;
  const selectedAgent = agents.find((agent) => agent.path === draftSettings.agentPath) ?? null;
  const activeProfileId = selection.kind === "profile" ? selection.profileId : null;
  const harnessLabel = formatHarnessLabel(draftSettings.harness);
  void snapshot;

  useEffect(() => {
    if (!editingProfile) {
      return;
    }
    setName(editingProfile.name);
    setDraftSettings(profileSettings(editingProfile));
  }, [editingProfile, editingProfileId]);

  useEffect(() => {
    if (editingProfileId !== "") {
      return;
    }
    setDraftSettings(currentSettings);
  }, [
    currentSettings.agentPath,
    currentSettings.agentSource,
    currentSettings.harness,
    currentSettings.model,
    currentSettings.reasoningEffort,
    currentSettings.serviceTier,
    editingProfileId,
  ]);

  const beginCreate = () => {
    setEditingProfileId("");
    setEditorStep("details");
    setName("");
    setDraftSettings(currentSettings);
    setError("");
  };

  const beginEdit = (profile: WorkbenchComposerProfile) => {
    controller.selectProfile(slot, profile.id);
    setEditingProfileId(profile.id);
    setEditorStep("details");
    setName(profile.name);
    setDraftSettings(profileSettings(profile));
    setError("");
  };

  const leaveEditor = () => {
    setEditingProfileId(null);
    setEditorStep("details");
    setError("");
  };

  const save = () => {
    try {
      if (editingProfile) {
        controller.updateProfile(editingProfile.id, { ...draftSettings, name });
      } else {
        const profile = controller.createProfile({
          ...draftSettings,
          name,
          scope: { kind: "project", projectId },
        });
        controller.selectProfile(slot, profile.id);
      }
      leaveEditor();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save that profile.");
    }
  };

  const cycleReasoningEffort = (direction: 1 | -1) => {
    const efforts = selectedModel?.supportedReasoningEfforts ?? [];
    if (!efforts.length) {
      return;
    }
    const currentIndex = efforts.indexOf(draftSettings.reasoningEffort ?? "");
    const nextIndex = ((currentIndex >= 0 ? currentIndex : 0) + direction + efforts.length) % efforts.length;
    setDraftSettings((current) => ({ ...current, reasoningEffort: efforts[nextIndex] ?? null }));
  };

  if (editingProfileId !== null && editorStep === "model") {
    return (
      <ThreadModelPicker
        appliesOnNextTurnOnly={false}
        deprioritizedModelIds={deprioritizedModelIds}
        error={modelsError}
        harness={draftSettings.harness}
        isLoading={isLoadingModels}
        isRefreshDisabled={isModelRefreshDisabled}
        isRefreshing={isModelRefreshing}
        models={models}
        selectedModelId={draftSettings.model}
        showsPriorityControls={false}
        onClose={() => setEditorStep("details")}
        onRefresh={onRefreshModels}
        onSelectModel={(model) => {
          setDraftSettings((current) => settingsFromModel({ ...current, model: model.id }, model));
          setEditorStep("details");
        }}
        onToggleModelPriority={() => {}}
      />
    );
  }

  if (editingProfileId !== null && editorStep === "agent") {
    return (
      <ThreadAgentPicker
        agents={agents}
        error={agentsError}
        isLoading={isLoadingAgents}
        isRefreshDisabled={isAgentRefreshDisabled}
        isRefreshing={isAgentRefreshing}
        selectedAgentPath={draftSettings.agentPath}
        onClose={() => setEditorStep("details")}
        onRefresh={onRefreshAgents}
        onSelectAgent={(agentPath) => {
          const agent = agents.find((candidate) => candidate.path === agentPath) ?? null;
          setDraftSettings((current) => ({
            ...current,
            agentPath,
            agentSource: agent?.source ?? null,
          }));
          setEditorStep("details");
        }}
      />
    );
  }

  if (editingProfileId !== null) {
    const isCreating = editingProfileId === "";
    const supportsFastMode = draftSettings.harness === "codex" && Boolean(selectedModel?.supportsFastMode);
    return (
      <section aria-label={isCreating ? "Create composer profile" : "Edit composer profile"}>
        <ThreadComposerPickerHeader
          actions={[{
            icon: <BackArrowIcon />,
            label: "Back to profiles",
            onClick: leaveEditor,
          }]}
          onClose={onClose}
          supportingText={isCreating
            ? "Use the harness control below to choose where this profile is created."
            : `${harnessLabel} profiles keep their original harness.`}
          title={isCreating ? `Create a ${harnessLabel} profile` : `Edit ${editingProfile?.name ?? "profile"}`}
        />

        <div className="mt-3 grid gap-3">
          <label className="grid gap-2 rounded-[1rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_98%,transparent)] px-4 py-3 text-[0.78em] font-semibold text-muted focus-within:border-text focus-within:ring-2 focus-within:ring-accent-soft">
            Profile name
            <input
              autoFocus
              value={name}
              placeholder="Name this ribbon state"
              className="min-w-0 bg-transparent text-[1.22em] font-semibold text-text outline-none placeholder:font-normal placeholder:text-muted"
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <div className="flex flex-wrap items-center gap-3 px-1 py-1">
            <ThreadComposerRibbon
              agentLabel={selectedAgent?.name ?? (draftSettings.agentPath ? "Unavailable agent" : "Default agent")}
              currentReasoningEffort={draftSettings.reasoningEffort}
              isFastModeEnabled={draftSettings.serviceTier === "fast"}
              isProfilePanelOpen={false}
              modelLabel={selectedModel?.displayName ?? (draftSettings.model || "Choose model")}
              profileLabel=""
              showsFastModeControl={supportsFastMode}
              showsProfileControl={false}
              showsReasoningEffortControl={Boolean(selectedModel?.supportsReasoningEffort && draftSettings.reasoningEffort)}
              onAgentOpen={() => setEditorStep("agent")}
              onFastModeToggle={() => setDraftSettings((current) => ({
                ...current,
                serviceTier: current.serviceTier === "fast" ? null : "fast",
              }))}
              onModelOpen={() => setEditorStep("model")}
              onProfileOpen={() => {}}
              onReasoningEffortCycle={cycleReasoningEffort}
            />
            <span className="text-[0.76em] text-muted">{harnessLabel} harness</span>
          </div>

          {editingProfile ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-[color-mix(in_srgb,var(--text)_8%,transparent)] pt-3">
              <button
                type="button"
                disabled={editingProfile.scope.kind === "project" && editingProfile.agentSource === "project"}
                title={editingProfile.agentSource === "project" ? "Project agent identities cannot be promoted globally." : undefined}
                className="rounded-full px-3 py-2 text-[0.76em] font-semibold text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => controller.updateProfile(editingProfile.id, {
                  scope: editingProfile.scope.kind === "global" ? { kind: "project", projectId } : { kind: "global" },
                })}
              >
                {editingProfile.scope.kind === "global" ? "Move to this project" : "Promote globally"}
              </button>
              <button
                type="button"
                aria-label={`Remove ${editingProfile.name}`}
                title={`Remove ${editingProfile.name}`}
                className={`${pickerIconButtonClassName} hover:!border-[color-mix(in_srgb,var(--danger)_30%,transparent)] hover:!text-danger`}
                onClick={() => {
                  controller.deleteProfile(editingProfile.id);
                  leaveEditor();
                }}
              >
                <FileDeleteIcon />
              </button>
            </div>
          ) : null}

          {error ? <p className="m-0 text-[0.78em] leading-[1.6] text-danger">{error}</p> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-full px-4 py-2 text-[0.8em] font-semibold text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text"
              onClick={leaveEditor}
            >
              Cancel
            </button>
            <PrimaryButton disabled={!name.trim() || !draftSettings.model} onClick={save}>Save profile</PrimaryButton>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Composer profiles">
      <ThreadComposerPickerHeader
        actions={[{
          icon: <SparkleIcon />,
          label: `Create ${formatHarnessLabel(currentSettings.harness)} profile`,
          onClick: beginCreate,
        }]}
        onClose={onClose}
        title="Choose a profile"
      />

      <div role="radiogroup" aria-label="Composer profiles" className="mt-3 grid gap-3">
        <button
          type="button"
          role="radio"
          aria-checked={selection.kind === "custom"}
          className={[
            "rounded-[1rem] border px-4 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
            selection.kind === "custom"
              ? "border-text bg-[color-mix(in_srgb,var(--text)_6%,transparent)]"
              : "border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_98%,transparent)] hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]",
          ].join(" ")}
          onClick={() => controller.selectCustom(slot, currentSettings)}
        >
          <p className="m-0 text-[0.96em] font-semibold text-text">Custom</p>
          <p className="mt-1 mb-0 text-[0.78em] leading-[1.6] text-muted">Use independent ribbon settings for this composer.</p>
        </button>

        {sortedProfiles.map((profile) => {
          const isActive = activeProfileId === profile.id;
          const isHiddenLink = selectedProfile?.id === profile.id && !visibleProfiles.some((candidate) => candidate.id === profile.id);
          const metadata = [
            profileScopeLabel(profile, projectId),
            formatHarnessLabel(profile.harness),
            profile.model,
            profile.reasoningEffort,
            profile.serviceTier === "fast" ? "Fast" : null,
          ].filter((value): value is string => Boolean(value));
          return (
            <div
              key={profile.id}
              className={[
                "flex items-start gap-3 rounded-[1rem] border px-4 py-3 transition",
                isActive
                  ? "border-text bg-[color-mix(in_srgb,var(--text)_6%,transparent)]"
                  : "border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_98%,transparent)] hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]",
              ].join(" ")}
            >
              <button
                type="button"
                role="radio"
                aria-checked={isActive}
                className="min-w-0 flex-1 text-left focus-visible:outline-none"
                onClick={() => controller.selectProfile(slot, profile.id)}
              >
                <span className="block text-[0.96em] font-semibold text-text">{profile.name}</span>
                <span className="mt-2 flex flex-wrap gap-2">
                  {metadata.map((item) => (
                    <span key={item} className="rounded-full bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-2.5 py-1 text-[0.72em] capitalize leading-[1.4] text-muted">{item}</span>
                  ))}
                </span>
                <span className="mt-2 block text-[0.76em] leading-[1.6] text-muted">
                  {isHiddenLink ? "Still linked here, but outside this project's selectable scope." : profile.agentPath ? `Agent: ${profile.agentPath}` : "Default agent"}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Edit ${profile.name}`}
                title={`Edit ${profile.name}`}
                className={pickerIconButtonClassName}
                onClick={() => beginEdit(profile)}
              >
                <FileUpdateIcon />
              </button>
            </div>
          );
        })}

        {!sortedProfiles.length ? (
          <p className="m-0 px-1 text-[0.84em] leading-[1.6] text-muted">No profiles are available here yet. Use the create action above and the harness control below.</p>
        ) : null}
      </div>
    </section>
  );
}
