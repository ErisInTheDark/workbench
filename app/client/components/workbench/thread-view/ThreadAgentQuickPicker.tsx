/*
 * Exports:
 * - default ThreadAgentQuickPicker: compact agent selection with full-editor activation.
 * - getThreadAgentQuickChoices: derive stable quick choices and canonical selected state from the agent catalogue.
 */
"use client";

import type { WorkbenchAgentOption, WorkbenchComposerSettings } from "workbench-shared/types";
import { areWorkbenchAgentPathsEqual } from "workbench-shared/workbench/agent-paths";
import PressDragMenu, { type PressDragMenuItem } from "../../ui/PressDragMenu";

interface ThreadAgentQuickChoice {
  id: string;
  agentPath: string | null;
  agentSource: WorkbenchComposerSettings["agentSource"];
  checked: boolean;
  description: string;
  name: string;
  path: string | null;
  sourceLabel: string | null;
}

export function getThreadAgentQuickChoices(
  agents: readonly WorkbenchAgentOption[],
  selectedAgentPath: string | null,
): ThreadAgentQuickChoice[] {
  return [
    {
      id: "default",
      agentPath: null,
      agentSource: null,
      checked: areWorkbenchAgentPathsEqual(selectedAgentPath, null),
      description: "",
      name: "Default agent",
      path: null,
      sourceLabel: null,
    },
    ...agents.map((agent) => ({
      id: `agent:${agent.path}`,
      agentPath: agent.path,
      agentSource: agent.source ?? null,
      checked: areWorkbenchAgentPathsEqual(selectedAgentPath, agent.path),
      description: agent.description,
      name: agent.name,
      path: agent.path,
      sourceLabel: agent.sourceLabel ?? null,
    })),
  ];
}

export default function ThreadAgentQuickPicker({
  agents,
  label,
  selectedAgentPath,
  onEdit,
  onOpen,
  onSelect,
}: {
  agents: readonly WorkbenchAgentOption[];
  label: string;
  selectedAgentPath: string | null;
  onEdit: (trigger: HTMLElement, ribbon: HTMLElement) => void;
  onOpen: () => void;
  onSelect: (agentPath: string | null, agentSource: WorkbenchComposerSettings["agentSource"]) => void;
}) {
  const choices = getThreadAgentQuickChoices(agents, selectedAgentPath);
  const choicesById = new Map(choices.map(choice => [choice.id, choice]));
  const openEditor = (trigger: HTMLButtonElement) => {
    const ribbon = trigger.parentElement;
    if (ribbon) onEdit(trigger, ribbon);
  };
  const items: PressDragMenuItem[] = [
    { id: "edit", content: "Edit agents" },
    ...choices.map(choice => ({
      id: choice.id,
      checked: choice.checked,
      content: choice.path ? <>
        <span className="block w-full truncate font-semibold text-text">{choice.name}</span>
        <span className="block w-full truncate text-xs leading-snug text-fg/muted">
          {choice.sourceLabel ? `${choice.sourceLabel} - ` : ""}{choice.path}
        </span>
        {choice.description ? <span className="line-clamp-2 w-full whitespace-pre-wrap text-xs leading-snug text-fg/muted">{choice.description}</span> : null}
      </> : choice.name,
    })),
  ];

  return <PressDragMenu
    label={`Composer agent: ${label}`}
    align="end"
    triggerClassName="max-w-48 truncate text-text"
    items={items}
    onOpen={onOpen}
    onActivate={openEditor}
    onSelect={(id, trigger) => {
      if (id === "edit") {
        openEditor(trigger);
        return;
      }
      const choice = choicesById.get(id);
      if (choice) onSelect(choice.agentPath, choice.agentSource);
    }}
  >
    <span className="truncate">{label}</span>
  </PressDragMenu>;
}
