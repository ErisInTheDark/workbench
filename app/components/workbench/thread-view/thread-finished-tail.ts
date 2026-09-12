/*
 * Exports:
 * - default getFinishedThreadTailHiddenItemIds: derive order-independent terminal reasoning and hoisted proposal visibility.
 */

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { WorkbenchSkillSummary } from "workbench-shared/types";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { getThreadCommandDisplay } from "../../../workbench/thread/thread-command-matchers";
import {
  readThreadGitArcMcpProposalTranscriptItem,
  readThreadGitArcProposalTranscriptItem,
} from "./thread-git-arc-presentation";

function getGitArcProposalId({
  item,
  knownSkills,
  projectRootPath,
  workspaceRoots,
}: {
  item: ThreadItem;
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  if (item.type === "mcpToolCall") {
    return readThreadGitArcMcpProposalTranscriptItem(item)?.proposalId ?? null;
  }
  if (item.type !== "commandExecution") {
    return null;
  }

  return readThreadGitArcProposalTranscriptItem(item, getThreadCommandDisplay({
    command: item.command,
    commandActions: item.commandActions,
    cwd: item.cwd,
    knownSkills,
    projectRootPath,
    workspaceRoots,
  }))?.proposalId ?? null;
}

export default function getFinishedThreadTailHiddenItemIds({
  hideReasoning,
  hoistedProposalIds,
  itemGroups,
  knownSkills,
  projectRootPath,
  workspaceRoots,
}: {
  hideReasoning: boolean;
  hoistedProposalIds: ReadonlySet<string>;
  itemGroups: readonly (readonly ThreadItem[])[];
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const hiddenItemIds = new Set<string>();
  for (let groupIndex = itemGroups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const items = itemGroups[groupIndex]!;
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex]!;
      if (hideReasoning && item.type === "reasoning") {
        hiddenItemIds.add(item.id);
        continue;
      }

      const proposalId = hoistedProposalIds.size
        ? getGitArcProposalId({ item, knownSkills, projectRootPath, workspaceRoots })
        : null;
      if (proposalId && hoistedProposalIds.has(proposalId)) {
        hiddenItemIds.add(item.id);
        continue;
      }

      return hiddenItemIds;
    }
  }

  return hiddenItemIds;
}
