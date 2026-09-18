/*
 * Exports:
 * - default ThreadProfileQuickPicker: compact profile actions using authoritative composer selection.
 */
"use client";

import type { WorkbenchAgentOption, WorkbenchComposerSettings, WorkbenchModelOption } from "workbench-shared/types";
import type { WorkbenchComposerProfileSlot } from "workbench-shared/types";
import { getWorkbenchAgentPathLabel } from "workbench-shared/workbench/agent-paths";
import { useWorkbenchComposerProfiles } from "../WorkbenchComposerProfileContext";
import WorkbenchPressDragMenu, { type PressDragMenuItem } from "../WorkbenchPressDragMenu";
import { BotIcon, ZapIcon } from "../workbench-icons";
import { getComposerProfileDisplayLabel } from "./composer-profile-label";
import { composerProfileRecency, orderComposerProfiles } from "./composer-profile-order";
import ThreadHarnessControl from "./ThreadHarnessControl";
import { formatProfileContext } from "./ThreadProfileEditor";
import { formatThreadRelativeTimestamp } from "./thread-view-formatters";

export default function ThreadProfileQuickPicker({
  slot, fallbackSettings, agents, models, label, selectedLabel, onEdit, onOpen,
}: {
  slot: WorkbenchComposerProfileSlot;
  fallbackSettings: WorkbenchComposerSettings;
  agents: readonly WorkbenchAgentOption[];
  models: readonly WorkbenchModelOption[];
  label: string;
  selectedLabel: string | null;
  onEdit: (trigger: HTMLElement, ribbon: HTMLElement) => void;
  onOpen: () => void;
}) {
  const profiles = useWorkbenchComposerProfiles();
  const openEditor = (trigger: HTMLButtonElement) => {
    const ribbon = trigger.parentElement;
    if (ribbon) onEdit(trigger, ribbon);
  };
  const getItems = (): PressDragMenuItem[] => {
    const selection = profiles.controller.getSelection(slot);
    const selected = profiles.controller.getSelectedProfile(slot);
    const visible = profiles.controller.getVisibleProfiles(slot.projectId,
      slot.kind === "new-thread" ? null : slot.harness);
    const available = selected && !visible.some(profile => profile.id === selected.id) ? [...visible, selected] : visible;
    const now = Date.now();
    return [
      { id: "edit", content: "Edit profiles" },
      ...orderComposerProfiles(available, "oldest").map(profile => {
        const agent = agents.find(entry => entry.path === profile.agentPath)?.name
          ?? getWorkbenchAgentPathLabel(profile.agentPath) ?? "Default agent";
        const model = profile.harness === fallbackSettings.harness ? models.find(entry => entry.id === profile.model) : null;
        const name = getComposerProfileDisplayLabel(profile, agent, model?.displayName);
        const recency = composerProfileRecency(profile);
        return {
          id: `profile:${profile.id}`,
          checked: selection.kind === "profile" && selection.profileId === profile.id,
          content: <>
            <span className="flex w-full min-w-0 items-baseline gap-3">
              <span className="min-w-0 truncate font-semibold text-text">{name}</span>
              <span className="ml-auto shrink-0 text-xs font-normal text-fg/muted">
                <time dateTime={new Date(recency).toISOString()} title={`${profile.lastUsedAt == null ? "Last edited" : "Last used"}: ${new Date(recency).toLocaleString()}`}>{formatThreadRelativeTimestamp(recency / 1000, now)}</time>
              </span>
            </span>
            <span className="block w-full truncate text-xs leading-snug text-fg/muted">
              <span className="font-semibold">{agent}</span> via {profile.serviceTier === "fast" ? <><ZapIcon className="inline align-[-0.1em]" size={12} /><span className="sr-only">fast</span>{" "}</> : null}
              <span className="font-semibold">{model?.displayName ?? profile.model}</span>
              {profile.reasoningEffort ? <> <span className="font-semibold capitalize">{profile.reasoningEffort}</span></> : null}
              {profile.contextWindowTokens ? <> <span className="font-semibold tabular-nums">{formatProfileContext(profile.contextWindowTokens)}</span></> : null} via <ThreadHarnessControl harness={profile.harness} inline />
            </span>
          </>,
        };
      }),
      { id: "custom", content: "Custom", checked: selection.kind === "custom" },
    ];
  };
  return <WorkbenchPressDragMenu
    label={`Composer profile: ${label}`}
    getItems={getItems}
    onOpen={() => { onOpen(); void profiles.controller.refreshProfiles(); }}
    onActivate={openEditor}
    onSelect={(id, trigger) => {
      if (id === "edit") {
        openEditor(trigger);
      } else if (id === "custom") {
        void profiles.controller.selectCustom(slot, profiles.controller.resolveSettings(slot) ?? fallbackSettings);
      } else {
        profiles.controller.selectProfile(slot, id.slice("profile:".length));
      }
    }}
  >
    <BotIcon className="shrink-0" size={18} />
    {selectedLabel ? <span className="truncate font-semibold">{selectedLabel}</span> : null}
  </WorkbenchPressDragMenu>;
}
