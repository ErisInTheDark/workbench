/*
 * Exports:
 * - CheckpointMetadata/ProposalMetadata/ArcOutcome: durable Git-backed arc metadata shapes and every stored commit identity. Keywords: git, arc, checkpoint, proposal, sha.
 * - checkpoint/proposal/outcome namespace helpers: own canonical and legacy Workbench ref naming. Keywords: git, ref, namespace, worktree.
 * - parse/format/remap helpers: validate marked metadata and rewrite every embedded commit identity. Keywords: git, metadata, rewrite, migration.
 */

export const CHECKPOINT_METADATA_MARKER = "workbench-git-checkpoint-v1";
export const PROPOSAL_METADATA_MARKER = "workbench-git-checkpoint-proposal-v1";
const CHECKPOINT_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/iu;

export type CheckpointKind = "arc" | "implement" | "plan";
export type GitArcHarness = "codex" | "copilot" | "opencode";
export type GitArcProposalStatus = "committed" | "proposed" | "rescinded" | "superseded" | "unavailable";
export type GitArcProposalUnavailableReasonCode = "committed-outside-proposal";

export interface CheckpointMetadata {
  adoptedPaths?: string[];
  amendedFrom: string | null;
  intentDescription?: string;
  kind: CheckpointKind;
  intentName?: string;
  priorProposalId?: string;
  registryLifecycle?: true;
  scopePaths: string[];
  version: 1 | 2 | 3;
}

export interface ProposalMetadata {
  amendTargetSha: string | null;
  baseCommit: string;
  committedSha: string | null;
  description: string;
  liveBaseCommit: string;
  livePaths: string[];
  messageOnly?: true;
  mode: "amend" | "commit";
  paths: string[];
  proposalId: string;
  sourceCheckpoint: string;
  status: GitArcProposalStatus;
  supersededByProposalId: string | null;
  supersededBySha: string | null;
  title: string;
  unavailableReason: string | null;
  unavailableReasonCode?: GitArcProposalUnavailableReasonCode | null;
  version: 1 | 2;
}

export interface ArcOutcome {
  acceptedProposals?: Array<{ commitSha: string; headSha: string; proposalId: string }>;
  committedSha: string | null;
  proposalId: string | null;
  sourceCheckpoint: string;
  status: "committed" | "continued" | "partial" | "proposed" | "released";
  successorCheckpoint: string | null;
  version: 1;
}

export function normalizeArcOutcome(outcome: ArcOutcome, currentHead?: string): ArcOutcome {
  if (outcome.acceptedProposals) return outcome;
  if (!outcome.proposalId || !outcome.committedSha) return { ...outcome, acceptedProposals: [] };
  return {
    ...outcome,
    acceptedProposals: [{
      commitSha: outcome.committedSha,
      headSha: currentHead ?? outcome.committedSha,
      proposalId: outcome.proposalId,
    }],
  };
}

export function normalizeThreadId(threadId: string) {
  const normalized = String(threadId ?? "").trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!normalized) throw new Error("A checkpoint thread id is required.");
  return normalized;
}

export function normalizeCommit(commit: string) {
  const normalized = String(commit ?? "").trim();
  if (!CHECKPOINT_COMMIT_PATTERN.test(normalized)) throw new Error("Invalid checkpoint commit.");
  return normalized;
}

export function checkpointNamespace(harness: GitArcHarness, threadId: string) {
  return `refs/worktree/agents/${harness}/${normalizeThreadId(threadId)}/checkpoints`;
}

export function legacyCheckpointNamespace(threadId: string) {
  return `refs/worktree/agents/${normalizeThreadId(threadId)}/checkpoints`;
}

export function proposalNamespace(harness: GitArcHarness, threadId: string) {
  return `refs/worktree/agents/${harness}/${normalizeThreadId(threadId)}/checkpoint-proposals`;
}

export function legacyProposalNamespace(threadId: string) {
  return `refs/worktree/agents/${normalizeThreadId(threadId)}/checkpoint-proposals`;
}

export function outcomeRef(harness: GitArcHarness, threadId: string, sourceCheckpoint: string) {
  return `refs/worktree/agents/${harness}/${normalizeThreadId(threadId)}/arc-outcomes/${normalizeCommit(sourceCheckpoint)}`;
}

export function checkpointMessage(metadata: CheckpointMetadata) {
  return `${CHECKPOINT_METADATA_MARKER}\n${JSON.stringify(metadata)}\n`;
}

export function proposalMessage(metadata: ProposalMetadata) {
  return `${PROPOSAL_METADATA_MARKER}\n${JSON.stringify(metadata)}\n`;
}

export function parseMarkedMetadata<T>(message: string, marker: string): T | null {
  const [firstLine, ...rest] = message.trim().split(/\r?\n/u);
  if (firstLine !== marker || !rest.length) return null;
  try {
    return JSON.parse(rest.join("\n")) as T;
  } catch {
    throw new Error("Checkpoint metadata is invalid.");
  }
}

function mapped(value: string | null, commits: ReadonlyMap<string, string>) {
  return value === null ? null : commits.get(value) ?? value;
}

export function remapCheckpointMetadata(metadata: CheckpointMetadata, commits: ReadonlyMap<string, string>): CheckpointMetadata {
  return { ...metadata, amendedFrom: mapped(metadata.amendedFrom, commits) };
}

export function remapProposalMetadata(metadata: ProposalMetadata, commits: ReadonlyMap<string, string>): ProposalMetadata {
  return {
    ...metadata,
    amendTargetSha: mapped(metadata.amendTargetSha, commits),
    baseCommit: mapped(metadata.baseCommit, commits)!,
    committedSha: mapped(metadata.committedSha, commits),
    liveBaseCommit: mapped(metadata.liveBaseCommit, commits)!,
    sourceCheckpoint: mapped(metadata.sourceCheckpoint, commits)!,
    supersededBySha: mapped(metadata.supersededBySha, commits),
  };
}

export function remapArcOutcome(outcome: ArcOutcome, commits: ReadonlyMap<string, string>): ArcOutcome {
  return {
    ...outcome,
    ...(outcome.acceptedProposals ? {
      acceptedProposals: outcome.acceptedProposals.map((proposal) => ({
        ...proposal,
        commitSha: mapped(proposal.commitSha, commits)!,
        headSha: mapped(proposal.headSha, commits)!,
      })),
    } : {}),
    committedSha: mapped(outcome.committedSha, commits),
    sourceCheckpoint: mapped(outcome.sourceCheckpoint, commits)!,
    successorCheckpoint: mapped(outcome.successorCheckpoint, commits),
  };
}
