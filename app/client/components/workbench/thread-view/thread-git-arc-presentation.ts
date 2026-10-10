/*
 * Exports:
 * - ThreadGitArcProposalTranscriptItem: associate one rendered proposal command with its receipt and editable message intent.
 * - readThreadGitArcProposalTranscriptItem/readThreadGitArcMcpProposalTranscriptItem: read CLI or MCP proposal identity and editable message intent.
 * - proposalIntentOwnsMessage: identify proposal intent that provides an explicit editable message.
 * - ThreadGitArcProposalPresentation: index proposal message intents and latest source turns from loaded transcript turns.
 * - getThreadGitArcWork: select a thread's useful Git arc work (claims, stash, actionable proposals, accepted commits from the current turn) using observed proposal validity.
 * - default getThreadGitArcProposalPresentation: derive proposal presentation facts from loaded transcript turns.
 */

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { ThreadPayload, WorkbenchSkillSummary } from "workbench-shared/types";
import type { GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import { readGitArcMcpResult } from "workbench-shared/workbench/git/git-arc-mcp-result";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type { WorkbenchGitArcLifecycleState } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchProjectedTranscriptTurn } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { ThreadGitArcProposalObservation } from "../../../workbench/thread/ThreadGitArcProposalObserver";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import {
  getGitArcMatcherAction,
  getWorkbenchMcpCommandRoute,
  getThreadCommandDisplay,
  parseGitArcReceipt,
  parseGitCheckpointCommitCommand,
  parseGitCheckpointProposalId,
  type GitCheckpointCommitCommandIntent,
  type ThreadCommandDisplay,
} from "../../../workbench/thread/thread-command-matchers";
import { formatToolCallOutput } from "./format-thread-tool-call";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;
type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

export interface ThreadGitArcProposalTranscriptItem {
  intent: GitCheckpointCommitCommandIntent | null;
  proposalId: string | null;
  receipt: GitArcReceipt | null;
}

export interface ThreadGitArcProposalPresentation {
  intents: Map<string, GitCheckpointCommitCommandIntent>;
  proposalTurnIds: Map<string, string>;
}

export function proposalIntentOwnsMessage(intent: GitCheckpointCommitCommandIntent | null) {
  return Boolean(intent?.title.trim());
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

export function readThreadGitArcMcpProposalTranscriptItem(
  item: McpToolCallItem,
): ThreadGitArcProposalTranscriptItem | null {
  const route = getWorkbenchMcpCommandRoute({
    argumentsValue: item.arguments,
    server: item.server,
    tool: item.tool,
  });
  if (route?.kind !== "specialized" || route.operation.kind !== "gitArc" || route.operation.operation.action !== "propose") {
    return null;
  }
  if (item.result?.structuredContent !== null && item.result?.structuredContent !== undefined) {
    const typed = readGitArcMcpResult(item.result.structuredContent);
    if (typed?.error) reportClientSchemaError("Rejected Git arc proposal result", typed.error);
    const receipt = typed?.kind === "valid" && typed.result.kind === "success" ? typed.result.receipt : null;
    return {
      intent: route.operation.operation.proposalIntent ?? null,
      proposalId: receipt?.proposalId ?? null,
      receipt,
    };
  }
  const output = item.error?.message || formatToolCallOutput({
    content: item.result?.content,
    fallback: item.result?.structuredContent ?? item.result?._meta,
  }) || "";
  const receipt = parseGitArcReceipt(output);
  return {
    intent: route.operation.operation.proposalIntent ?? null,
    proposalId: parseGitCheckpointProposalId(output) ?? receipt?.proposalId ?? null,
    receipt,
  };
}

export function getThreadGitArcWork({
  currentTurnId,
  gitArc,
  proposalObservations,
  proposalTurnIds,
}: {
  currentTurnId: string | null;
  gitArc: WorkbenchGitArcLifecycleState | null;
  proposalObservations: Readonly<Record<string, ThreadGitArcProposalObservation>>;
  proposalTurnIds: ReadonlyMap<string, string>;
}) {
  if (!gitArc) return null;
  // Observed Git validity wins over the lifecycle's status; only actionable or landed proposals are work.
  const proposals = gitArc.proposals.flatMap((proposal) => {
    const observation = proposalObservations[proposal.proposalId];
    const status = observation?.status === "loaded" ? observation.proposal.status : proposal.status;
    return status === "proposed" || status === "committed" ? [{ ...proposal, status }] : [];
  });
  const work = proposals.length === gitArc.proposals.length
    && proposals.every((proposal, index) => proposal.status === gitArc.proposals[index]?.status)
    ? gitArc
    : { ...gitArc, proposals };
  // Claimed and stashed files are work whatever their proposals say, so they stay reachable.
  if (gitArc.claimedPaths.length || gitArc.stashedPaths?.length || gitArc.phase === "stashed") return work;
  if (!proposals.length) return null;
  if (proposals.some(({ status }) => status === "proposed")) return work;
  // Accepted-only work is news for the turn that landed it, not for every later turn.
  return currentTurnId && proposals.some(({ proposalId }) => (
    proposalTurnIds.get(proposalId) === currentTurnId
  )) ? work : null;
}

export default function getThreadGitArcProposalPresentation({
  knownSkills,
  projectRootPath,
  turns,
  workspaceRoots,
}: {
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  turns: ThreadPayload["turns"] | WorkbenchProjectedTranscriptTurn[];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}): ThreadGitArcProposalPresentation {
  const intents = new Map<string, GitCheckpointCommitCommandIntent>();
  const proposalTurnIds = new Map<string, string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      const proposal = item.type === "commandExecution"
        ? readThreadGitArcProposalTranscriptItem(item, getThreadCommandDisplay({
          command: item.command,
          commandActions: item.commandActions,
          cwd: item.cwd,
          knownSkills,
          projectRootPath,
          workspaceRoots,
        }))
        : item.type === "mcpToolCall" ? readThreadGitArcMcpProposalTranscriptItem(item) : null;
      if (!proposal?.proposalId) continue;
      proposalTurnIds.set(proposal.proposalId, turn.id);
      if (proposal.intent) intents.set(proposal.proposalId, proposal.intent);
    }
  }
  return { intents, proposalTurnIds };
}
