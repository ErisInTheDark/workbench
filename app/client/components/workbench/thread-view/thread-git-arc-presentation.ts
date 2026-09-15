/*
 * Exports:
 * - ThreadGitArcProposalTranscriptItem: associate one rendered proposal command with its receipt and editable message intent.
 * - readThreadGitArcProposalTranscriptItem/readThreadGitArcMcpProposalTranscriptItem: read CLI or MCP proposal identity and editable message intent.
 * - proposalIntentOwnsMessage: identify proposal intent that provides an explicit editable message.
 * - ThreadGitArcProposalSource/ThreadGitArcProposalPresentation: index proposal controller inputs and latest source turns from loaded transcript turns.
 * - getHoistedThreadGitArc: select useful terminal Git arc work without duplicating Git validity.
 * - default getThreadGitArcProposalPresentation: derive proposal presentation facts from loaded transcript turns.
 */

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { ThreadPayload, WorkbenchSkillSummary } from "workbench-shared/types";
import type { GitArcReceipt } from "workbench-shared/workbench/git/git-arc-receipts";
import type { WorkbenchGitArcLifecycleState } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchProjectedTranscriptTurn } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { ThreadGitArcProposalObservation } from "../../../workbench/WorkbenchThreadController";
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
  sources: Map<string, ThreadGitArcProposalSource>;
}

export interface ThreadGitArcProposalSource {
  cwd: string | null;
  intent: GitCheckpointCommitCommandIntent | null;
  sourceItemId: string;
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

export function getHoistedThreadGitArc({
  currentTurn,
  gitArc,
  proposalObservations,
  proposalTurnIds,
}: {
  currentTurn: Pick<ThreadPayload["turns"][number], "id" | "status"> | null;
  gitArc: WorkbenchGitArcLifecycleState | null;
  proposalObservations: Readonly<Record<string, ThreadGitArcProposalObservation>>;
  proposalTurnIds: ReadonlyMap<string, string>;
}) {
  if (!gitArc || currentTurn?.status === "inProgress") return null;
  const proposals = gitArc.proposals.flatMap(({ proposalId, status: lifecycleStatus }) => {
    const observation = proposalObservations[proposalId];
    const status = observation?.status === "loaded" ? observation.proposal.status : lifecycleStatus;
    return status === "proposed" || status === "committed" ? [{ proposalId, status }] : [];
  });
  const visibleGitArc = proposals.length === gitArc.proposals.length
    && proposals.every((proposal, index) => proposal.status === gitArc.proposals[index]?.status)
    ? gitArc
    : { ...gitArc, proposals };
  if (gitArc.claimedPaths.length) return visibleGitArc;
  if (!proposals.length) return null;
  if (proposals.some(({ status }) => status === "proposed")) return visibleGitArc;
  return currentTurn && proposals.some(({ proposalId }) => (
    proposalTurnIds.get(proposalId) === currentTurn.id
  )) ? visibleGitArc : null;
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
  const sources = new Map<string, ThreadGitArcProposalSource>();
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
      sources.set(proposal.proposalId, {
        cwd: item.type === "commandExecution" ? item.cwd : null,
        intent: proposal.intent,
        sourceItemId: item.id,
      });
    }
  }
  return { intents, proposalTurnIds, sources };
}
