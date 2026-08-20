/*
 * Exports:
 * - ThreadGitArcProposalTranscriptItem: associate one rendered proposal command with its receipt and editable message intent. Keywords: thread, git, arc, proposal, transcript.
 * - readThreadGitArcProposalTranscriptItem: read proposal identity and message intent through the same matcher path used by transcript rendering. Keywords: thread, command, proposal, intent.
 * - default getThreadGitArcProposalIntents: index proposal message intents from the currently loaded transcript turns. Keywords: thread, git, arc, proposal, visible, intent.
 */

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { ThreadPayload, WorkbenchSkillSummary } from "../../../lib/types";
import type { GitArcReceipt } from "../../../lib/workbench/git/git-arc-receipts";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import {
  getGitArcMatcherAction,
  getThreadCommandDisplay,
  parseGitArcReceipt,
  parseGitCheckpointCommitCommand,
  parseGitCheckpointProposalId,
  type GitCheckpointCommitCommandIntent,
  type ThreadCommandDisplay,
} from "../../../lib/workbench/thread/thread-command-matchers";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;

export interface ThreadGitArcProposalTranscriptItem {
  intent: GitCheckpointCommitCommandIntent | null;
  proposalId: string | null;
  receipt: GitArcReceipt | null;
}

function readProposalIntent(item: CommandItem, commandDisplay: ThreadCommandDisplay) {
  const commands = [commandDisplay.unwrappedCommand, ...item.commandActions.map(({ command }) => command)];
  for (const command of commands) {
    const intent = parseGitCheckpointCommitCommand(command);
    if (intent) return intent;
  }
  return null;
}

export function readThreadGitArcProposalTranscriptItem(
  item: CommandItem,
  commandDisplay: ThreadCommandDisplay,
): ThreadGitArcProposalTranscriptItem | null {
  if (getGitArcMatcherAction(commandDisplay.claimedBy) !== "propose") return null;
  const receipt = parseGitArcReceipt(item.aggregatedOutput ?? "");
  return {
    intent: readProposalIntent(item, commandDisplay),
    proposalId: parseGitCheckpointProposalId(item.aggregatedOutput ?? "") ?? receipt?.proposalId ?? null,
    receipt,
  };
}

export default function getThreadGitArcProposalIntents({
  knownSkills,
  projectRootPath,
  turns,
  workspaceRoots,
}: {
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  turns: ThreadPayload["turns"];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const intents = new Map<string, GitCheckpointCommitCommandIntent>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== "commandExecution") continue;
      const proposal = readThreadGitArcProposalTranscriptItem(item, getThreadCommandDisplay({
        command: item.command,
        commandActions: item.commandActions,
        cwd: item.cwd,
        knownSkills,
        projectRootPath,
        workspaceRoots,
      }));
      if (proposal?.proposalId && proposal.intent) intents.set(proposal.proposalId, proposal.intent);
    }
  }
  return intents;
}
