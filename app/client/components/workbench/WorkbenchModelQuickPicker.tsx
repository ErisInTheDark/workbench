/*
 * Exports:
 * - default WorkbenchModelQuickPicker: composer model menu over the thread owner's account model catalogues.
 */
"use client";

import type { WorkbenchHarness } from "workbench-shared/types";
import { useThread } from "./use-thread";
import { HarnessIcon } from "./workbench-icons";
import type { WorkbenchGroupedModel } from "./workbench-model-groups";
import WorkbenchModelMenu from "./WorkbenchModelMenu";

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
  const modelCatalogues = useThread.models(threadId);
  const catalogues = Object.fromEntries(allowedHarnesses.map(key => [key, modelCatalogues.get(key) ?? []]));
  return <WorkbenchModelMenu
    label={`Composer model: ${providerLabel} ${modelName}`}
    align="end"
    catalogues={catalogues}
    allowedHarnesses={allowedHarnesses}
    selected={{ harness, modelId }}
    onOpen={onOpen}
    onSelect={onSelect}
  ><HarnessIcon harness={harness} size={18} className="shrink-0" /><span className="truncate">{modelName}</span></WorkbenchModelMenu>;
}
