/*
 * Exports:
 * - default WorkbenchModelQuickPicker: hook-backed grouped model selection with saved disclosure indicators.
 */
"use client";

import type { WorkbenchHarness, WorkbenchModelOption } from "workbench-shared/types";
import { useWorkbenchModelCatalogues } from "./use-workbench-client";
import { useWorkbenchClientStateSnapshot } from "./workbench-client-state-context";
import { ClockIcon, HarnessIcon, StarIcon } from "./workbench-icons";
import { groupWorkbenchModels, type WorkbenchGroupedModel } from "./workbench-model-groups";
import WorkbenchPressDragMenu, { type PressDragMenuGroup } from "./WorkbenchPressDragMenu";

export default function WorkbenchModelQuickPicker ({
  allowedHarnesses, harness, modelName, providerLabel, modelId, threadId, onOpen, onSelect,
}: {
  allowedHarnesses: readonly WorkbenchHarness[];
  harness: WorkbenchHarness;
  modelName: string;
  providerLabel: string;
  modelId: string;
  threadId: string;
  onOpen: () => void;
  onSelect: (entry: WorkbenchGroupedModel) => void;
}) {
  const modelCatalogues = useWorkbenchModelCatalogues(threadId);
  const clientState = useWorkbenchClientStateSnapshot();
  const favourites = clientState.records.flatMap(record =>
    record.kind === "modelPreference" && record.favourite
      ? [{ harness: record.harness, modelId: record.modelId }] : []);
  const disclosureOpen = new Map(clientState.records.flatMap(record =>
    record.kind === "modelGroupDisclosure" ? [[record.groupId, record.open] as const] : []));
  const catalogues = Object.fromEntries(allowedHarnesses.map(key =>
    [key, modelCatalogues.get(key) ?? []])) as Partial<Record<WorkbenchHarness, readonly WorkbenchModelOption[]>>;
  const groups = groupWorkbenchModels({
    catalogues, favourites, allowedHarnesses, now: Date.now(), order: "drag",
  });
  const choices = new Map<string, WorkbenchGroupedModel>();
  const menuGroups: PressDragMenuGroup[] = groups.map(group => ({
    id: group.id,
    label: group.label,
    open: disclosureOpen.get(group.id) ?? true,
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
          <HarnessIcon harness={entry.harness} size={16} className="shrink-0" />
          <span className="truncate">{entry.model.displayName}</span>
        </span>,
      };
    }),
  }));
  return <WorkbenchPressDragMenu
    label={`Composer model: ${providerLabel} ${modelName}`}
    groupNavigationLabel="Model sections"
    triggerClassName="text-text"
    groups={menuGroups}
    onOpen={onOpen}
    onSelect={id => {
      const choice = choices.get(id);
      if (choice) onSelect(choice);
    }}
  ><HarnessIcon harness={harness} size={18} className="shrink-0" /><span className="truncate">{modelName}</span></WorkbenchPressDragMenu>;
}
