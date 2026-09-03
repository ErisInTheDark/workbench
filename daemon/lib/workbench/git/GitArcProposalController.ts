/*
 * Exports:
 * - default GitArcProposalController: own proposal creation, replacement, rescission, acceptance, receipts, and lifecycle projection. Keywords: git, arc, proposal, acceptance, lifecycle, rebase, branch replacement.
 * - GitArcLifecycleState: durable active or resolved arc projection with ordered visible proposal summaries. Keywords: git, arc, lifecycle, sidebar, proposals.
 * - GitArcAcceptedProposalsError: preserve accepted proposal receipts and remaining claims when continuation must stop. Keywords: git, arc, proposal, accepted, error.
 * - GitCheckpointProposalReceipt: durable proposal identity returned after proposal publication. Keywords: git, proposal, receipt, commit.
 */
import { randomUUID } from "node:crypto";

import type { GitCheckpointProposal } from "workbench-shared/workbench/git/checkpoint-contracts";
import { GitArcMissingClaimSetError, GitArcProposalAlreadyCommittedError } from "workbench-shared/workbench/git/git-arc-failures";
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import GitArcProposalCache from "./GitArcProposalCache";
import GitArcPublishState from "./GitArcPublishState";
import GitArcRegistry, { REGISTRY_REF, type GitArcRegistryEntry } from "./GitArcRegistry";
import GitCheckpointStore, {
  type GitArcProposalSummary,
  type StoredCheckpoint,
  type StoredProposal,
} from "./GitCheckpointStore";
import WorkbenchGitHistoryRewriter from "./WorkbenchGitHistoryRewriter";
import WorkbenchGitRepository, { type GitRefUpdate } from "./WorkbenchGitRepository";
import {
  type ArcOutcome,
  type CheckpointMetadata,
  type GitArcHarness,
  outcomeRef,
  proposalMessage,
  proposalNamespace,
  type ProposalMetadata,
  remapArcOutcome,
  remapProposalMetadata,
} from "workbench-shared/workbench/git/git-arc-storage";

interface ArcIdentityInput {
  cwd: string;
  harness?: GitArcHarness;
  threadId: string;
}

const BRANCH_CHANGED_UNAVAILABLE_REASON = "The branch changed after this proposal was created, so it can no longer be committed as proposed.";

export interface GitCheckpointProposalReceipt {
  baseCommit: string;
  description: string;
  intentName: string | null;
  paths: string[];
  proposalId: string;
  scopePaths: string[];
  sourceCheckpoint: string;
  title: string;
}

export interface GitArcLifecycleState {
  checkpointCommit: string;
  claimedPaths: string[];
  harness: string;
  intentDescription: string;
  intentName: string;
  phase: "active" | "resolved";
  proposals: Array<{ proposalId: string; status: "committed" | "proposed" }>;
  threadId: string;
  updatedAt: string;
}

function normalizeHarness(harness: string | undefined): GitArcHarness {
  const normalized = String(harness ?? "codex").trim().toLowerCase();
  if (normalized === "codex" || normalized === "copilot" || normalized === "opencode") return normalized;
  throw new Error("A valid checkpoint harness is required.");
}

function lifecycleEntry(entry: GitArcRegistryEntry) {
  if (entry.phase === "plan") {
    return entry.retainedArc ? {
      checkpointCommit: entry.retainedArc.checkpointCommit,
      claimedPaths: entry.retainedArc.claimedPaths,
      intentDescription: entry.retainedArc.intentDescription,
      intentName: entry.retainedArc.intentName,
      phase: entry.retainedArc.phase,
      proposalIds: entry.retainedArc.proposalIds,
    } : null;
  }
  return {
    checkpointCommit: entry.checkpointCommit,
    claimedPaths: entry.claimedPaths,
    intentDescription: entry.intentDescription,
    intentName: entry.intentName,
    phase: entry.phase === "resolved" ? "resolved" as const : "active" as const,
    proposalIds: entry.proposalIds ?? [],
  };
}

function projectLifecycleState(
  entry: GitArcRegistryEntry,
  lifecycle: NonNullable<ReturnType<typeof lifecycleEntry>>,
  summaries: GitArcProposalSummary[],
): GitArcLifecycleState {
  return {
    checkpointCommit: lifecycle.checkpointCommit,
    claimedPaths: lifecycle.claimedPaths,
    harness: entry.harness,
    intentDescription: lifecycle.intentDescription,
    intentName: lifecycle.intentName,
    phase: lifecycle.phase,
    proposals: summaries.flatMap(({ proposalId, status }) => (
      status === "proposed" || status === "committed" ? [{ proposalId, status }] : []
    )),
    threadId: entry.threadId,
    updatedAt: entry.updatedAt,
  };
}

function acceptedReceiptMessage(receipts: Array<{ commitSha: string; proposalId: string; title: string }>, claimedPaths: string[]) {
  return [
    "Accepted commit proposals:",
    ...receipts.map(({ commitSha, title }) => `- ${title} (${commitSha})`),
    "",
    claimedPaths.length
      ? `This legacy Git arc still owns ${claimedPaths.length} claimed path${claimedPaths.length === 1 ? "" : "s"}.`
      : "This Git arc is resolved and owns no live claims.",
    "Call mcp__wbex__git_arc_plan_start with the explicit next paths when the approved plan is unchanged.",
    "Return to Brief mode and call mcp__wbex__git_arc_plan when the plan changed.",
  ].join("\n");
}

export class GitArcAcceptedProposalsError extends Error {
  readonly claimedPaths: string[];
  readonly receipts: Array<{ commitSha: string; proposalId: string; title: string }>;

  constructor(receipts: Array<{ commitSha: string; proposalId: string; title: string }>, claimedPaths: string[]) {
    super(acceptedReceiptMessage(receipts, claimedPaths));
    this.name = "GitArcAcceptedProposalsError";
    this.receipts = receipts.map((receipt) => ({ ...receipt }));
    this.claimedPaths = [...claimedPaths];
  }
}

function requireArcMetadata(metadata: CheckpointMetadata | null) {
  if (!metadata || (metadata.kind !== "arc" && metadata.kind !== "implement") || !metadata.scopePaths.length) {
    throw new GitArcMissingClaimSetError();
  }
  return metadata;
}

function proposalAlreadyCommitted(proposal: StoredProposal) {
  const commitSha = proposal.metadata.committedSha;
  if (!commitSha) throw new Error("Committed proposal metadata does not include a commit SHA.");
  return new GitArcProposalAlreadyCommittedError(commitSha, proposal.metadata.proposalId, proposal.metadata.title);
}

function pathIsCoveredBy(candidate: string, scopePath: string) {
  return candidate === scopePath || candidate.startsWith(`${scopePath}/`);
}

async function readArcChain(
  store: GitCheckpointStore,
  harness: GitArcHarness,
  threadId: string,
  startCheckpoint: StoredCheckpoint,
  requiredCheckpoint: string,
) {
  const chain: StoredCheckpoint[] = [];
  let cursor = startCheckpoint;
  for (let depth = 0; depth < 100; depth += 1) {
    chain.push(cursor);
    if (cursor.checkpointCommit === requiredCheckpoint) return chain;
    if (!cursor.metadata?.amendedFrom) break;
    cursor = await store.readCheckpoint(harness, threadId, cursor.metadata.amendedFrom);
  }
  throw new Error("The proposal no longer belongs to this thread's active Git arc.");
}

async function readAcceptedReceipts(
  store: GitCheckpointStore,
  harness: GitArcHarness,
  threadId: string,
  chain: StoredCheckpoint[],
) {
  const outcomes = await Promise.all(chain.map(async ({ checkpointCommit }) => (
    await store.readOutcome(harness, threadId, checkpointCommit)
  )));
  const receipts = outcomes.slice().reverse().flatMap((outcome) => outcome?.acceptedProposals ?? []);
  return receipts.filter((receipt, index) => receipts.findIndex(({ proposalId }) => proposalId === receipt.proposalId) === index);
}

async function prepareAcceptedClaimTransition({
  acceptedHead,
  active,
  commitRemaps,
  harness,
  proposalId,
  registry,
  repository,
  source,
  store,
  threadId,
}: {
  acceptedHead: string;
  active: GitArcRegistryEntry;
  commitRemaps?: ReadonlyMap<string, string>;
  harness: GitArcHarness;
  proposalId: string;
  registry: GitArcRegistry;
  repository: WorkbenchGitRepository;
  source: StoredCheckpoint;
  store: GitCheckpointStore;
  threadId: string;
}) {
  const currentTree = await repository.writeScopedWorktreeTree(active.claimedPaths, acceptedHead);
  const changedPaths = await repository.listChangedPaths(acceptedHead, currentTree, active.claimedPaths);
  const claimedPaths = active.claimedPaths.filter((claimedPath) => (
    changedPaths.some((changedPath) => pathIsCoveredBy(changedPath, claimedPath))
  ));
  const sourceCheckpoint = commitRemaps?.get(source.checkpointCommit) ?? source.checkpointCommit;
  let successorCheckpoint: string | null = null;
  const updates: GitRefUpdate[] = [];
  if (claimedPaths.length) {
    requireArcMetadata(source.metadata);
    const metadata: CheckpointMetadata = {
      amendedFrom: sourceCheckpoint,
      ...(active.intentDescription ? { intentDescription: active.intentDescription } : {}),
      ...(active.intentName ? { intentName: active.intentName } : {}),
      kind: "arc",
      priorProposalId: proposalId,
      registryLifecycle: true,
      scopePaths: claimedPaths,
      version: 3,
    };
    const prepared = await store.prepareCheckpoint(
      harness,
      threadId,
      await repository.resolveTree(acceptedHead),
      acceptedHead,
      metadata,
    );
    successorCheckpoint = prepared.checkpointCommit;
    updates.push(prepared.update);
  }
  const registryMutation = await registry.prepareClaim({
    checkpointCommit: successorCheckpoint ?? sourceCheckpoint,
    claimedPaths,
    harness,
    intentDescription: active.intentDescription,
    intentName: active.intentName,
    phase: claimedPaths.length ? "active" : "resolved",
    proposalId: active.proposalId ?? null,
    proposalIds: active.proposalIds ?? (active.proposalId ? [active.proposalId] : []),
    retainedArc: null,
    threadId,
  }, { commitRemaps, expectedCheckpointCommit: active.checkpointCommit });
  if (registryMutation.update) updates.push(registryMutation.update);
  return {
    claimedPaths,
    sourceCheckpoint,
    status: claimedPaths.length ? "partial" as const : "committed" as const,
    successorCheckpoint,
    updates,
  };
}

function commitMessage(title: string, description: string) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("A commit title is required.");
  return description.trim() ? `${normalizedTitle}\n\n${description.trim()}\n` : `${normalizedTitle}\n`;
}

function parseCommitMessage(message: string) {
  const [title = "", ...description] = message.trim().split(/\r?\n/u);
  return { description: description.join("\n").trim(), title: title.trim() };
}

function acceptanceFailure(error: unknown) {
  const cause = (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?")
    .slice(0, 500);
  return new Error(
    `Commit was not published. The proposal remains pending and workspace files are unchanged. Resolve the reported cause, then retry the same Commit action. No arc repair command is required. Cause: ${cause}`,
    { cause },
  );
}

const proposalFileChangesCache = new GitArcProposalCache();

async function buildProposalFileChanges(
  repository: WorkbenchGitRepository,
  metadata: ProposalMetadata,
  target: string,
  harness: GitArcHarness,
  threadId: string,
) {
  const [baseTree, targetTree] = await Promise.all([
    repository.resolveTree(metadata.baseCommit),
    repository.resolveTree(target),
  ]);
  return await proposalFileChangesCache.readOrBuild({
    baseTree,
    build: async () => await repository.buildFileChanges(metadata.baseCommit, target, metadata.paths),
    harness,
    paths: metadata.paths,
    proposalId: metadata.proposalId,
    rootPath: repository.root,
    targetTree,
    threadId,
  });
}

async function buildProposalResult(
  repository: WorkbenchGitRepository,
  metadata: ProposalMetadata,
  target: string,
  harness: GitArcHarness,
  threadId: string,
  includeNewerAvailable = false,
): Promise<GitCheckpointProposal> {
  const classifiedAmendability = metadata.status === "committed" && metadata.committedSha
    ? await new WorkbenchGitHistoryRewriter(repository).classifyAmendability(metadata.committedSha)
    : null;
  const amendability: GitCheckpointProposal["amendability"] = classifiedAmendability?.status === "available"
    ? { status: "available" }
    : classifiedAmendability;
  return {
    ...(amendability ? { amendability } : {}),
    amendTargetSha: metadata.amendTargetSha,
    baseCommit: metadata.baseCommit,
    changes: await buildProposalFileChanges(repository, metadata, target, harness, threadId),
    committedSha: metadata.committedSha,
    description: metadata.description,
    includeNewerAvailable,
    mode: metadata.mode,
    paths: metadata.paths,
    proposalId: metadata.proposalId,
    status: metadata.status,
    supersededByProposalId: metadata.supersededByProposalId,
    supersededBySha: metadata.supersededBySha,
    title: metadata.title,
    unavailableReason: metadata.unavailableReason,
    unavailableReasonCode: metadata.unavailableReasonCode ?? null,
  };
}

async function transitionProposal(repository: WorkbenchGitRepository, proposal: StoredProposal, metadata: ProposalMetadata, treeish?: string) {
  const tree = treeish ?? proposal.tree;
  const stateCommit = await repository.createCommitFromTree(tree, metadata.baseCommit, proposalMessage(metadata));
  await repository.updateRefs([{ newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef }]);
  return { ...proposal, metadata, proposalCommit: stateCommit, tree };
}

async function resolveProposalState(repository: WorkbenchGitRepository, harness: GitArcHarness, threadId: string, proposalId: string) {
  const store = new GitCheckpointStore(repository);
  let proposal = await store.readProposal(harness, threadId, proposalId);
  let currentTree: string | null = null;
  const legacyCommittedHistoryReason = proposal.metadata.status === "unavailable"
    && proposal.metadata.unavailableReason?.startsWith("Proposed paths changed in committed history:");
  const branchChangeUnavailable = proposal.metadata.status === "unavailable"
    && proposal.metadata.unavailableReason === BRANCH_CHANGED_UNAVAILABLE_REASON;
  if (proposal.metadata.status === "proposed" || legacyCommittedHistoryReason || branchChangeUnavailable) {
    const headMovement = await repository.classifyHeadMovement(proposal.metadata.liveBaseCommit, proposal.metadata.livePaths);
    const replayableBranchReplacement = headMovement.kind === "incompatible"
      && proposal.metadata.mode === "commit"
      && !(await repository.listChangedPaths(
        proposal.metadata.liveBaseCommit,
        headMovement.currentHead,
        proposal.metadata.livePaths,
      )).length;
    const committedOutsideProposal = headMovement.kind === "fast-forward"
      && headMovement.changedPaths.length > 0
      && !(await repository.listChangedPaths(
        proposal.proposalCommit,
        headMovement.currentHead,
        proposal.metadata.livePaths,
      )).length;
    let unavailableReason: string | null = headMovement.kind === "incompatible" && !replayableBranchReplacement
      ? BRANCH_CHANGED_UNAVAILABLE_REASON
      : committedOutsideProposal
        ? "These changes were committed outside this proposal."
      : headMovement.changedPaths.length
        ? "A newer commit changed files in this proposal, so it can no longer be committed as proposed."
        : null;
    const canRebaseCommit = proposal.metadata.mode === "commit"
      && !unavailableReason
      && (headMovement.kind === "fast-forward" || replayableBranchReplacement);
    if ((proposal.metadata.status === "proposed" || branchChangeUnavailable) && canRebaseCommit) {
      const rebasedTree = await repository.writeTreeWithPathsFromSource(
        headMovement.currentHead,
        proposal.proposalCommit,
        proposal.metadata.paths,
      );
      proposal = await transitionProposal(repository, proposal, {
        ...proposal.metadata,
        baseCommit: headMovement.currentHead,
        liveBaseCommit: headMovement.currentHead,
        status: "proposed",
        unavailableReason: null,
        unavailableReasonCode: null,
      }, rebasedTree);
    } else if (proposal.metadata.status === "proposed" && !unavailableReason && headMovement.kind === "fast-forward") {
      proposal = await transitionProposal(repository, proposal, {
        ...proposal.metadata,
        liveBaseCommit: headMovement.currentHead,
      });
    } else if (branchChangeUnavailable && !unavailableReason) {
      proposal = await transitionProposal(repository, proposal, {
        ...proposal.metadata,
        status: "proposed",
        unavailableReason: null,
        unavailableReasonCode: null,
      });
    }
    if (proposal.metadata.status === "proposed" && !unavailableReason && !proposal.metadata.messageOnly) {
      currentTree = await repository.writeScopedWorktreeTree(proposal.metadata.livePaths, proposal.metadata.liveBaseCommit);
      const changedNow = new Set(await repository.listChangedPaths(
        proposal.metadata.liveBaseCommit,
        currentTree,
        proposal.metadata.livePaths,
      ));
      const cleanPath = proposal.metadata.livePaths.find((filePath) => !changedNow.has(filePath));
      if (cleanPath) unavailableReason = `${cleanPath} no longer has working-tree changes.`;
    }
    const unavailableReasonCode = committedOutsideProposal ? "committed-outside-proposal" : null;
    if (unavailableReason && (
      proposal.metadata.status !== "unavailable"
      || proposal.metadata.unavailableReason !== unavailableReason
      || proposal.metadata.unavailableReasonCode !== unavailableReasonCode
    )) {
      proposal = await transitionProposal(repository, proposal, {
        ...proposal.metadata,
        status: "unavailable",
        unavailableReason,
        unavailableReasonCode,
      });
    }
  }
  const includeNewerAvailable = proposal.metadata.status === "proposed"
    && currentTree !== null
    && (await repository.listChangedPaths(proposal.proposalCommit, currentTree, proposal.metadata.livePaths)).length > 0;
  return { currentTree, includeNewerAvailable, proposal };
}

export default class GitArcProposalController {
  async listLifecycleStates({ cwd }: { cwd: string }): Promise<GitArcLifecycleState[]> {
    const repository = await WorkbenchGitRepository.tryOpen(cwd);
    if (!repository) return [];
    const entries = await new GitArcRegistry(repository).list();
    const projected = entries.map((entry) => ({ entry, lifecycle: lifecycleEntry(entry) })).filter((value) => value.lifecycle !== null);
    const summaries = await new GitCheckpointStore(repository).readProposalSummaryGroups(projected.map(({ entry, lifecycle }) => ({
      harness: normalizeHarness(entry.harness),
      proposalIds: lifecycle!.proposalIds,
      threadId: entry.threadId,
    })));
    return projected.map(({ entry, lifecycle }, index) => (
      projectLifecycleState(entry, lifecycle!, summaries[index] ?? [])
    ));
  }

  async findLifecycleState(input: ArcIdentityInput) {
    const repository = await WorkbenchGitRepository.tryOpen(input.cwd);
    if (!repository) return null;
    const harness = normalizeHarness(input.harness);
    const entry = await new GitArcRegistry(repository).find({ harness, threadId: input.threadId });
    if (!entry) return null;
    const lifecycle = lifecycleEntry(entry);
    if (!lifecycle) return null;
    const summaries = await new GitCheckpointStore(repository).readProposalSummaries(
      harness,
      input.threadId,
      lifecycle.proposalIds,
    );
    return projectLifecycleState(entry, lifecycle, summaries);
  }

  async requireNoAcceptedReceipts(input: ArcIdentityInput & { checkpointCommit: string }) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const store = new GitCheckpointStore(repository);
    const outcome = await store.readOutcome(harness, input.threadId, input.checkpointCommit);
    const receipts = outcome?.acceptedProposals ?? [];
    if (receipts.length) {
      const entry = await new GitArcRegistry(repository).find({ harness, threadId: input.threadId });
      const claimedPaths = entry?.phase === "active" && entry.checkpointCommit === input.checkpointCommit
        ? entry.claimedPaths
        : [];
      const titledReceipts = await Promise.all(receipts.map(async (receipt) => ({
        commitSha: receipt.commitSha,
        proposalId: receipt.proposalId,
        title: (await store.readProposal(harness, input.threadId, receipt.proposalId)).metadata.title,
      })));
      throw new GitArcAcceptedProposalsError(titledReceipts, claimedPaths);
    }
  }

  async logicalBaseline(input: ArcIdentityInput & { checkpointCommit: string; fallbackHead: string }) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const outcome = await new GitCheckpointStore(repository).readOutcome(harness, input.threadId, input.checkpointCommit);
    return outcome?.acceptedProposals?.at(-1)?.headSha ?? input.fallbackHead;
  }

  private async createMessageOnlyProposal({
    amendProposalId,
    cwd,
    description,
    harness: rawHarness,
    threadId,
    title,
  }: ArcIdentityInput & { amendProposalId: string; description: string; title: string }): Promise<GitCheckpointProposalReceipt> {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const store = new GitCheckpointStore(repository);
    const target = await store.readProposal(harness, threadId, amendProposalId);
    if (target.metadata.status !== "committed" || !target.metadata.committedSha) {
      throw new Error("A targeted message amend requires a committed proposal.");
    }
    const amendability = await new WorkbenchGitHistoryRewriter(repository).classifyAmendability(target.metadata.committedSha);
    if (amendability.status === "unavailable") throw new Error(amendability.reason);
    const inherited = parseCommitMessage(await repository.readCommitMessage(amendability.resolvedTarget));
    const proposalTitle = title.trim() || inherited.title;
    const proposalDescription = title.trim() ? description.trim() : inherited.description;
    commitMessage(proposalTitle, proposalDescription);
    if (proposalTitle === inherited.title && proposalDescription === inherited.description) {
      throw new Error("The proposed commit message is unchanged.");
    }

    const source = await store.readCheckpoint(harness, threadId, target.metadata.sourceCheckpoint);
    const sourceMetadata = requireArcMetadata(source.metadata);
    const registry = new GitArcRegistry(repository);
    const current = await registry.find({ harness, threadId });
    const proposalId = randomUUID();
    const metadata: ProposalMetadata = {
      amendTargetSha: amendability.resolvedTarget,
      baseCommit: await repository.resolveParent(amendability.resolvedTarget),
      committedSha: null,
      description: proposalDescription,
      liveBaseCommit: await repository.currentHead(),
      livePaths: [],
      messageOnly: true,
      mode: "amend",
      paths: target.metadata.paths,
      proposalId,
      sourceCheckpoint: source.checkpointCommit,
      status: "proposed",
      supersededByProposalId: null,
      supersededBySha: null,
      title: proposalTitle,
      unavailableReason: null,
      version: 2,
    };
    const proposalTree = await repository.resolveTree(amendability.resolvedTarget);
    const proposalCommit = await repository.createCommitFromTree(proposalTree, metadata.baseCommit, proposalMessage(metadata));
    const currentProposalIds = current?.proposalIds ?? (current?.proposalId ? [current.proposalId] : []);
    const proposalIds = [...new Set([...currentProposalIds, proposalId])];
    const registryMutation = await registry.prepareClaim(current ? {
      ...current,
      proposalId,
      proposalIds,
      ...(current.retainedArc ? {
        retainedArc: {
          ...current.retainedArc,
          proposalIds: [...new Set([...current.retainedArc.proposalIds, proposalId])],
        },
      } : {}),
    } : {
      checkpointCommit: source.checkpointCommit,
      claimedPaths: [],
      harness,
      intentDescription: sourceMetadata.intentDescription ?? "",
      intentName: sourceMetadata.intentName ?? "message amendment",
      phase: "resolved",
      proposalId,
      proposalIds,
      retainedArc: null,
      threadId,
    }, current ? { expectedCheckpointCommit: current.checkpointCommit } : undefined);
    await repository.updateRefs([
      { newValue: proposalCommit, oldValue: "0".repeat(40), ref: `${proposalNamespace(harness, threadId)}/${proposalId}` },
      ...(registryMutation.update ? [registryMutation.update] : []),
    ]);
    return {
      baseCommit: metadata.baseCommit,
      description: metadata.description,
      intentName: sourceMetadata.intentName ?? null,
      paths: metadata.paths,
      proposalId,
      scopePaths: sourceMetadata.scopePaths,
      sourceCheckpoint: source.checkpointCommit,
      title: metadata.title,
    };
  }

  async createProposal({
    amend,
    amendProposalId,
    cwd,
    description,
    harness: rawHarness,
    paths: rawPaths,
    replaceProposalId,
    threadId,
    title,
  }: ArcIdentityInput & {
    amend?: boolean;
    amendProposalId?: string;
    description: string;
    paths?: string[];
    replaceProposalId?: string;
    title: string;
  }): Promise<GitCheckpointProposalReceipt> {
    if (amendProposalId && !amend && !rawPaths?.length) {
      return await this.createMessageOnlyProposal({
        amendProposalId,
        cwd,
        description,
        harness: rawHarness,
        threadId,
        title,
      });
    }
    const { active, checkpoint, harness, metadata: checkpointMetadata, registry, repository } = await this.requireActiveArc({ cwd, harness: rawHarness, threadId });
    const proposalIds = active.proposalIds ?? (active.proposalId ? [active.proposalId] : []);
    const store = new GitCheckpointStore(repository);
    let replacementTarget: StoredProposal | null = null;
    if (replaceProposalId) {
      replacementTarget = await store.readProposal(harness, threadId, replaceProposalId);
      if (replacementTarget.metadata.status === "committed") {
        throw proposalAlreadyCommitted(replacementTarget);
      }
      if (replacementTarget.metadata.status !== "proposed" && replacementTarget.metadata.status !== "unavailable") {
        throw new Error("Only a pending or unavailable proposal can be replaced.");
      }
    }
    let amendTargetProposal: StoredProposal | null = null;
    if (amendProposalId) {
      amendTargetProposal = await store.readProposal(harness, threadId, amendProposalId);
      if (amendTargetProposal.metadata.status !== "committed" || !amendTargetProposal.metadata.committedSha) {
        throw new Error("A targeted amend requires a committed proposal.");
      }
      amend = true;
    }
    const requestedPaths = rawPaths?.length
      ? repository.normalizePaths(rawPaths)
      : repository.normalizePaths(checkpointMetadata.scopePaths);
    if (rawPaths?.length) {
      const outsideClaim = requestedPaths.filter((candidate) => (
        !checkpointMetadata.scopePaths.some((scopePath) => pathIsCoveredBy(candidate, scopePath))
      ));
      if (outsideClaim.length) throw new Error(`Proposed paths must stay within the arc's claimed set: ${outsideClaim.join(", ")}`);
    }
    const logicalBaseline = (await store.readOutcome(harness, threadId, checkpoint.checkpointCommit))?.acceptedProposals?.at(-1)?.headSha
      ?? checkpoint.parent;
    const headMovement = await repository.classifyHeadMovement(logicalBaseline, requestedPaths, logicalBaseline);
    if (headMovement.kind === "incompatible") {
      throw new Error("Repository HEAD moved incompatibly after this arc began. Create a new plan before proposing a commit.");
    }
    if (headMovement.changedPaths.length) {
      throw new Error(`Proposed paths no longer match the arc baseline: ${headMovement.changedPaths.join(", ")}`);
    }
    const liveBaseCommit = headMovement.currentHead;
    const amendTargetSha = amendTargetProposal?.metadata.committedSha ?? (amend ? liveBaseCommit : null);
    if (amendTargetSha) {
      if (amendTargetProposal) await new GitArcPublishState(repository).requireAmendableCommit(amendTargetSha);
      else await new GitArcPublishState(repository).requireAmendableCurrentHead();
    }
    const baseCommit = amendTargetSha ? await repository.resolveParent(amendTargetSha) : liveBaseCommit;
    const proposalTree = await repository.writeScopedWorktreeTree(requestedPaths, amendTargetSha ?? liveBaseCommit);
    const livePaths = await repository.listChangedPaths(liveBaseCommit, proposalTree, requestedPaths);
    if (!livePaths.length) throw new Error("The selected arc paths do not contain any working-tree changes to propose.");
    const paths = amendTargetSha
      ? await repository.listAllChangedPaths(baseCommit, proposalTree)
      : livePaths;
    const inheritedMessage = amendTargetSha ? parseCommitMessage(await repository.readCommitMessage(amendTargetSha)) : null;
    const proposalTitle = title.trim() || inheritedMessage?.title || "";
    const proposalDescription = title.trim() ? description.trim() : inheritedMessage?.description ?? description.trim();
    const proposalId = randomUUID();
    const metadata: ProposalMetadata = {
      amendTargetSha,
      baseCommit,
      committedSha: null,
      description: proposalDescription,
      liveBaseCommit,
      livePaths,
      mode: amendTargetSha ? "amend" : "commit",
      paths,
      proposalId,
      sourceCheckpoint: checkpoint.checkpointCommit,
      status: "proposed",
      supersededByProposalId: null,
      supersededBySha: null,
      title: proposalTitle,
      unavailableReason: null,
      version: 2,
    };
    commitMessage(metadata.title, metadata.description);
    const proposalCommit = await repository.createCommitFromTree(proposalTree, baseCommit, proposalMessage(metadata));
    await buildProposalFileChanges(repository, metadata, proposalCommit, harness, threadId);
    const registryMutation = await registry.prepareSet({
      ...active,
      proposalId,
      proposalIds: [...proposalIds, proposalId],
    }, active.checkpointCommit);
    let supersededProposalUpdate: GitRefUpdate | null = null;
    if (replacementTarget) {
      const supersededMetadata: ProposalMetadata = {
        ...replacementTarget.metadata,
        status: "superseded",
        supersededByProposalId: proposalId,
        supersededBySha: null,
        unavailableReason: null,
      };
      const supersededState = await repository.createCommitFromTree(
        replacementTarget.tree,
        replacementTarget.metadata.baseCommit,
        proposalMessage(supersededMetadata),
      );
      supersededProposalUpdate = {
        newValue: supersededState,
        oldValue: replacementTarget.proposalCommit,
        ref: replacementTarget.proposalRef,
      };
    }
    await repository.updateRefs([
      ...(supersededProposalUpdate ? [supersededProposalUpdate] : []),
      { newValue: proposalCommit, oldValue: "0".repeat(40), ref: `${proposalNamespace(harness, threadId)}/${proposalId}` },
      ...(registryMutation.update ? [registryMutation.update] : []),
    ]);
    return {
      baseCommit,
      description: metadata.description,
      intentName: checkpointMetadata.intentName ?? null,
      paths: metadata.paths,
      proposalId,
      scopePaths: checkpointMetadata.scopePaths,
      sourceCheckpoint: checkpoint.checkpointCommit,
      title: metadata.title,
    };
  }

  async getProposal({ cwd, harness: rawHarness, includeNewer, proposalId, threadId }: ArcIdentityInput & { includeNewer: boolean; proposalId: string }) {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const { currentTree, includeNewerAvailable, proposal } = await resolveProposalState(repository, harness, threadId, proposalId);
    const target = (proposal.metadata.status === "committed" || proposal.metadata.status === "superseded") && proposal.metadata.committedSha
      ? proposal.metadata.committedSha
      : includeNewer && includeNewerAvailable && currentTree
        ? currentTree
        : proposal.proposalCommit;
    return await buildProposalResult(repository, proposal.metadata, target, harness, threadId, includeNewerAvailable);
  }

  async getProposalPaths({ cwd, harness: rawHarness, proposalId, threadId }: ArcIdentityInput & { proposalId: string }) {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const proposal = await new GitCheckpointStore(repository).readProposal(harness, threadId, proposalId);
    return [...proposal.metadata.paths];
  }

  async rescindProposal(input: ArcIdentityInput & { proposalId: string }) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const proposal = await new GitCheckpointStore(repository).readProposal(harness, input.threadId, input.proposalId);
    if (proposal.metadata.status === "committed") {
      throw proposalAlreadyCommitted(proposal);
    }
    if (proposal.metadata.status !== "proposed") throw new Error("Only a pending proposal can be rescinded.");
    const metadata = { ...proposal.metadata, status: "rescinded" as const, unavailableReason: null };
    const stateCommit = await repository.createCommitFromTree(proposal.tree, metadata.baseCommit, proposalMessage(metadata));
    await repository.updateRefs([{ newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef }]);
    return { committedSha: null, proposalId: metadata.proposalId, status: metadata.status };
  }

  private async commitMessageAmendment({
    description,
    harness,
    proposal,
    repository,
    threadId,
    title,
  }: {
    description: string;
    harness: GitArcHarness;
    proposal: StoredProposal;
    repository: WorkbenchGitRepository;
    threadId: string;
    title: string;
  }) {
    const target = proposal.metadata.committedSha ?? proposal.metadata.amendTargetSha;
    if (!target) throw new Error("A message amendment requires an exact committed target.");
    const message = commitMessage(title, description);
    if (message.trim() === (await repository.readCommitMessage(target)).trim()) {
      throw new Error("The amended commit message is unchanged.");
    }
    const store = new GitCheckpointStore(repository);
    const supersededPrior = proposal.metadata.status === "proposed"
      ? await store.findCommittedProposalBySha(harness, threadId, target, proposal.metadata.proposalId)
      : null;
    const oldOutcomeRef = outcomeRef(harness, threadId, proposal.metadata.sourceCheckpoint);
    const oldOutcomeValue = await repository.readRef(oldOutcomeRef);
    const oldOutcome = await store.readOutcome(harness, threadId, proposal.metadata.sourceCheckpoint);
    let committedMetadata: ProposalMetadata | null = null;
    let amendedCommit: string | null = null;
    try {
      await new WorkbenchGitHistoryRewriter(repository).amend({
        excludeArcRefs: [
          proposal.proposalRef,
          oldOutcomeRef,
          ...(supersededPrior ? [supersededPrior.proposalRef] : []),
        ],
        expectedHead: proposal.metadata.status === "proposed" ? proposal.metadata.liveBaseCommit : undefined,
        message,
        messageOnly: true,
        paths: [],
        target,
        targetTree: proposal.tree,
        mutatePlan: async ({ amendedCommit: nextCommit, arcPlan, newHead, targetTree }) => {
          amendedCommit = nextCommit;
          const sourceCheckpoint = arcPlan.commits.get(proposal.metadata.sourceCheckpoint) ?? proposal.metadata.sourceCheckpoint;
          committedMetadata = {
            ...remapProposalMetadata(proposal.metadata, arcPlan.commits),
            amendTargetSha: nextCommit,
            committedSha: nextCommit,
            description: description.trim(),
            liveBaseCommit: newHead,
            sourceCheckpoint,
            status: "committed",
            title: title.trim(),
            unavailableReason: null,
          };
          const stateCommit = await repository.createCommitFromTree(targetTree, committedMetadata.baseCommit, proposalMessage(committedMetadata));
          const updates: GitRefUpdate[] = [{ newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef }];
          const replaceRefs = [proposal.proposalRef, oldOutcomeRef];
          if (supersededPrior) {
            const priorMetadata: ProposalMetadata = {
              ...remapProposalMetadata(supersededPrior.metadata, arcPlan.commits),
              committedSha: nextCommit,
              status: "superseded",
              supersededByProposalId: proposal.metadata.proposalId,
              supersededBySha: nextCommit,
            };
            const priorState = await repository.createCommitFromTree(supersededPrior.tree, priorMetadata.baseCommit, proposalMessage(priorMetadata));
            updates.push({ newValue: priorState, oldValue: supersededPrior.proposalCommit, ref: supersededPrior.proposalRef });
            replaceRefs.push(supersededPrior.proposalRef);
          }
          const remappedOutcome = oldOutcome ? remapArcOutcome(oldOutcome, arcPlan.commits) : null;
          const acceptedProposals = [...remappedOutcome?.acceptedProposals ?? []];
          const receipt = { commitSha: nextCommit, headSha: newHead, proposalId: proposal.metadata.proposalId };
          const receiptIndex = acceptedProposals.findIndex((candidate) => candidate.proposalId === receipt.proposalId);
          if (receiptIndex >= 0) acceptedProposals[receiptIndex] = receipt;
          else acceptedProposals.push(receipt);
          const nextOutcomeRef = outcomeRef(harness, threadId, sourceCheckpoint);
          const outcomeBlob = await repository.writeBlob(`${JSON.stringify({
            acceptedProposals,
            committedSha: nextCommit,
            proposalId: proposal.metadata.proposalId,
            sourceCheckpoint,
            status: remappedOutcome?.status ?? "committed",
            successorCheckpoint: remappedOutcome?.successorCheckpoint ?? null,
            version: 1,
          } satisfies ArcOutcome)}\n`);
          updates.push({
            newValue: outcomeBlob,
            oldValue: nextOutcomeRef === oldOutcomeRef ? oldOutcomeValue ?? "0".repeat(40) : "0".repeat(40),
            ref: nextOutcomeRef,
          });
          replaceRefs.push(nextOutcomeRef);
          return {
            deletes: oldOutcomeValue && nextOutcomeRef !== oldOutcomeRef ? [{ oldValue: oldOutcomeValue, ref: oldOutcomeRef }] : [],
            replaceRefs,
            updates,
          };
        },
      });
    } catch (error) {
      const cause = (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
      throw new Error(`Commit message was not amended. ${proposal.metadata.status === "proposed" ? "The amendment proposal remains pending. " : "The committed proposal is unchanged. "}Cause: ${cause}`, { cause });
    }
    if (!committedMetadata || !amendedCommit) throw new Error("Commit message amendment metadata was not committed.");
    return await buildProposalResult(repository, committedMetadata, amendedCommit, harness, threadId);
  }

  async commitProposal({
    cwd,
    description,
    harness: rawHarness,
    includeNewer,
    proposalId,
    threadId,
    title,
  }: ArcIdentityInput & { description: string; includeNewer: boolean; proposalId: string; title: string }): Promise<GitCheckpointProposal> {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const resolved = await resolveProposalState(repository, harness, threadId, proposalId);
    const proposal = resolved.proposal;
    if (proposal.metadata.status === "committed") {
      return await this.commitMessageAmendment({ description, harness, proposal, repository, threadId, title });
    }
    if (proposal.metadata.status !== "proposed") {
      throw new Error(proposal.metadata.unavailableReason || "Checkpoint proposal is not available to commit.");
    }
    if (proposal.metadata.messageOnly) {
      return await this.commitMessageAmendment({ description, harness, proposal, repository, threadId, title });
    }
    const store = new GitCheckpointStore(repository);
    const proposalSource = await store.readCheckpoint(harness, threadId, proposal.metadata.sourceCheckpoint);
    requireArcMetadata(proposalSource.metadata);
    const registry = new GitArcRegistry(repository);
    const active = await registry.find({ harness, threadId });
    if (!active || active.phase === "plan") {
      throw new Error("The proposal no longer belongs to this thread's Git arc.");
    }
    const activeSource = await store.readCheckpoint(harness, threadId, active.checkpointCommit);
    const activeChain = await readArcChain(store, harness, threadId, activeSource, proposalSource.checkpointCommit);
    const previousAcceptedProposals = await readAcceptedReceipts(store, harness, threadId, activeChain);
    if (proposal.metadata.mode === "amend") {
      const message = commitMessage(title, description);
      const targetTree = includeNewer && resolved.includeNewerAvailable ? resolved.currentTree! : proposal.tree;
      const oldOutcomeRef = outcomeRef(harness, threadId, activeSource.checkpointCommit);
      const supersededProposalId = previousAcceptedProposals.slice().reverse().find((receipt) => (
        receipt.commitSha === proposal.metadata.amendTargetSha && receipt.proposalId !== proposalId
      ))?.proposalId ?? null;
      const supersededPrior = supersededProposalId
        ? await store.readProposal(harness, threadId, supersededProposalId)
        : await store.findCommittedProposalBySha(harness, threadId, proposal.metadata.amendTargetSha, proposalId);
      let committedMetadata: ProposalMetadata | null = null;
      let committedResult: GitCheckpointProposal | null = null;
      try {
        await new WorkbenchGitHistoryRewriter(repository).amend({
          excludeArcRefs: [
            proposal.proposalRef,
            REGISTRY_REF,
            oldOutcomeRef,
            ...(supersededPrior ? [supersededPrior.proposalRef] : []),
          ],
          expectedHead: proposal.metadata.liveBaseCommit,
          message,
          paths: proposal.metadata.livePaths,
          target: proposal.metadata.amendTargetSha,
          targetTree,
          mutatePlan: async ({ amendedCommit, arcPlan, newHead }) => {
          const remappedSource = arcPlan.commits.get(activeSource.checkpointCommit) ?? activeSource.checkpointCommit;
          committedMetadata = {
            ...remapProposalMetadata(proposal.metadata, arcPlan.commits),
            amendTargetSha: amendedCommit,
            committedSha: amendedCommit,
            description: description.trim(),
            liveBaseCommit: newHead,
            sourceCheckpoint: remappedSource,
            status: "committed",
            title: title.trim(),
            unavailableReason: null,
          };
          const stateCommit = await repository.createCommitFromTree(targetTree, committedMetadata.baseCommit, proposalMessage(committedMetadata));
          const updates: GitRefUpdate[] = [{ newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef }];
          const replaceRefs = [proposal.proposalRef, REGISTRY_REF];
          if (supersededPrior) {
            const priorMetadata: ProposalMetadata = {
              ...remapProposalMetadata(supersededPrior.metadata, arcPlan.commits),
              committedSha: amendedCommit,
              status: "superseded",
              supersededByProposalId: proposalId,
              supersededBySha: amendedCommit,
            };
            const priorState = await repository.createCommitFromTree(supersededPrior.tree, priorMetadata.baseCommit, proposalMessage(priorMetadata));
            updates.push({ newValue: priorState, oldValue: supersededPrior.proposalCommit, ref: supersededPrior.proposalRef });
            replaceRefs.push(supersededPrior.proposalRef);
          }
          const transition = await prepareAcceptedClaimTransition({
            acceptedHead: newHead,
            active,
            commitRemaps: arcPlan.commits,
            harness,
            proposalId,
            registry,
            repository,
            source: activeSource,
            store,
            threadId,
          });
          updates.push(...transition.updates);
          const oldOutcome = await repository.readRef(oldOutcomeRef);
          const nextOutcomeRef = outcomeRef(harness, threadId, transition.sourceCheckpoint);
          const acceptedProposals = previousAcceptedProposals.map((receipt) => ({
            ...receipt,
            commitSha: arcPlan.commits.get(receipt.commitSha) ?? receipt.commitSha,
            headSha: arcPlan.commits.get(receipt.headSha) ?? receipt.headSha,
          }));
          acceptedProposals.push({ commitSha: amendedCommit, headSha: newHead, proposalId });
          const outcomeBlob = await repository.writeBlob(`${JSON.stringify({
            acceptedProposals,
            committedSha: amendedCommit,
            proposalId,
            sourceCheckpoint: transition.sourceCheckpoint,
            status: transition.status,
            successorCheckpoint: transition.successorCheckpoint,
            version: 1,
          } satisfies ArcOutcome)}\n`);
          updates.push({
            newValue: outcomeBlob,
            oldValue: oldOutcomeRef === nextOutcomeRef ? oldOutcome ?? "0".repeat(40) : "0".repeat(40),
            ref: nextOutcomeRef,
          });
          replaceRefs.push(oldOutcomeRef, nextOutcomeRef);
          committedResult = await buildProposalResult(repository, committedMetadata, amendedCommit, harness, threadId);
          return {
            deletes: oldOutcome && oldOutcomeRef !== nextOutcomeRef ? [{ oldValue: oldOutcome, ref: oldOutcomeRef }] : [],
            replaceRefs,
            updates,
          };
          },
        });
      } catch (error) {
        throw acceptanceFailure(error);
      }
      if (!committedMetadata || !committedResult) throw new Error("Amend proposal metadata was not committed.");
      return committedResult;
    }

    const message = commitMessage(title, description);
    const targetTree = includeNewer && resolved.includeNewerAvailable ? resolved.currentTree! : proposal.tree;
    const committedSha = await repository.createCommitFromTree(targetTree, proposal.metadata.baseCommit, message);
    const committedMetadata: ProposalMetadata = {
      ...proposal.metadata,
      committedSha,
      description: description.trim(),
      status: "committed",
      title: title.trim(),
      unavailableReason: null,
    };
    const stateCommit = await repository.createCommitFromTree(targetTree, proposal.metadata.baseCommit, proposalMessage(committedMetadata));
    const acceptedProposals = [...previousAcceptedProposals];
    if (!acceptedProposals.some((receipt) => receipt.proposalId === proposalId)) {
      acceptedProposals.push({ commitSha: committedSha, headSha: committedSha, proposalId });
    }
    const transition = await prepareAcceptedClaimTransition({
      acceptedHead: committedSha,
      active,
      harness,
      proposalId,
      registry,
      repository,
      source: activeSource,
      store,
      threadId,
    });
    const outcomeUpdate = await store.prepareOutcome(harness, threadId, {
      acceptedProposals,
      committedSha,
      proposalId,
      sourceCheckpoint: transition.sourceCheckpoint,
      status: transition.status,
      successorCheckpoint: transition.successorCheckpoint,
      version: 1,
    });
    const headRef = await repository.symbolicHead() ?? "HEAD";
    const result = await buildProposalResult(repository, committedMetadata, committedSha, harness, threadId);
    try {
      await repository.publishRefsAfterIndexNormalization({
        indexCommit: committedSha,
        paths: proposal.metadata.livePaths,
        updates: [
          { newValue: committedSha, oldValue: proposal.metadata.liveBaseCommit, ref: headRef },
          { newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef },
          outcomeUpdate,
          ...transition.updates,
        ],
      });
    } catch (error) {
      throw acceptanceFailure(error);
    }
    return result;
  }

  async prepareUnavailableUpdates({
    cwd,
    harness: rawHarness,
    proposalIds,
    reason,
    threadId,
  }: ArcIdentityInput & { proposalIds: string[]; reason: string }) {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const store = new GitCheckpointStore(repository);
    const updates = await Promise.all(proposalIds.map(async (proposalId): Promise<GitRefUpdate | null> => {
      const proposal = await store.readProposal(harness, threadId, proposalId);
      if (proposal.metadata.status !== "proposed") return null;
      const stateCommit = await repository.createCommitFromTree(
        proposal.tree,
        proposal.metadata.baseCommit,
        proposalMessage({ ...proposal.metadata, status: "unavailable", unavailableReason: reason }),
      );
      return { newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef };
    }));
    return updates.filter((update): update is GitRefUpdate => update !== null);
  }

  private async requireActiveArc(input: ArcIdentityInput) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = new GitArcRegistry(repository);
    const active = await registry.find({ harness, threadId: input.threadId });
    if (!active || active.phase !== "active") throw new Error("This thread does not own an active Git arc.");
    const checkpoint = await new GitCheckpointStore(repository).readCheckpoint(harness, input.threadId, active.checkpointCommit);
    const metadata = requireArcMetadata(checkpoint.metadata);
    if (
      metadata.scopePaths.length !== active.claimedPaths.length
      || metadata.scopePaths.some((scopePath, index) => scopePath !== active.claimedPaths[index])
    ) throw new Error("The active Git arc registry does not match its checkpoint claim set.");
    return { active, checkpoint, harness, metadata, registry, repository };
  }
}
