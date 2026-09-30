/*
 * Exports:
 * - default ThreadModelQuickPicker: grouped press-drag model selection for Custom composer settings.
 */
"use client";

import type { WorkbenchHarness, WorkbenchModelOption } from "workbench-shared/types";
import { useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";
import { ClockIcon, HarnessIcon, StarIcon } from "../workbench-icons";
import WorkbenchPressDragMenu, { type PressDragMenuGroup } from "../WorkbenchPressDragMenu";
import { groupThreadModels, type ThreadGroupedModel } from "./thread-model-groups";

export default function ThreadModelQuickPicker({
  allowedHarnesses, catalogues, harness, label, modelId, onOpen, onSelect,
}: {
  allowedHarnesses: readonly WorkbenchHarness[];
  catalogues: Partial<Record<WorkbenchHarness, readonly WorkbenchModelOption[]>>;
  harness: WorkbenchHarness;
  label: string;
  modelId: string;
  onOpen: () => void;
  onSelect: (entry: ThreadGroupedModel) => void;
}) {
  const clientState = useWorkbenchClientStateSnapshot();
  const favourites = clientState.records.flatMap(record =>
    record.kind === "modelPreference" && record.favourite
      ? [{ harness: record.harness, modelId: record.modelId }] : []);
  const groups = groupThreadModels({
    catalogues, favourites, allowedHarnesses, now: Date.now(),
  });
  const choices = new Map<string, ThreadGroupedModel>();
  const menuGroups: PressDragMenuGroup[] = groups.map(group => ({
    id: group.id,
    label: group.label,
    navigation: group.providerId && group.providerId !== "opencode" ? undefined
      : group.kind === "favourites" ? <StarIcon size={20} />
        : group.kind === "recent" ? <ClockIcon size={20} />
          : <HarnessIcon harness={group.harness!} size={20} />,
    items: group.models.map(entry => {
      const id = `${group.id}\0${entry.harness}\0${entry.model.id}`;
      choices.set(id, entry);
      return {
        id,
        checked: harness === entry.harness && modelId === entry.model.id,
        content: <span className="flex min-w-0 items-center gap-2">
          {group.kind !== "provider" ? <HarnessIcon harness={entry.harness} size={16} className="shrink-0" /> : null}
          <span className="truncate">{entry.model.displayName}</span>
        </span>,
      };
    }),
  }));
  return <WorkbenchPressDragMenu
    label={`Composer model: ${label}`}
    groups={menuGroups}
    onOpen={onOpen}
    onSelect={id => {
      const choice = choices.get(id);
      if (choice) onSelect(choice);
    }}
  ><span className="truncate">{label}</span></WorkbenchPressDragMenu>;
}
