/*
 * Exports:
 * - default GitArcProposalController: own proposal validity (including stacked proposals), bounded diff hydration, publication, acceptance, and lifecycle projection.
 * - GitArcLifecycleState: active or resolved arc with ordered proposal summaries.
 * - GitArcAcceptedProposalsError: accepted receipts and remaining claims when continuation stops.
 * - GitCheckpointProposalReceipt: published proposal identity.
 */
import { randomUUID } from "node:crypto";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";

import type { GitCheckpointProposal, GitCheckpointRequest } from "workbench-shared/workbench/git/checkpoint-contracts";
import { GitArcMissingClaimSetError, GitArcProposalAlreadyCommittedError } from "workbench-shared/workbench/git/git-arc-failures";
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import type { GitArcSavedStash } from "workbench-shared/workbench/git/git-arc-storage";
import GitArcProposalDiffController from "./GitArcProposalDiffController";
import {
  passthroughGitArcThreadIdentityResolver,
  type GitArcThreadIdentityResolver,
} from "./git-arc-thread-identity";
import GitArcPublishState from "./GitArcPublishState";
import GitArcRegistry, { REGISTRY_REF, getGitArcLiveClaimPaths, type GitArcRegistryEntry } from "./GitArcRegistry";
import GitArcStackController, { type GitArcStackStatusResolver } from "./GitArcStackController";
import { gitArcPathsOverlap } from "workbench-shared/workbench/git/git-arc-paths";
import GitCheckpointStore, {
  type GitArcProposalSummary,
  type StoredCheckpoint,
  type StoredProposal,
} from "./GitCheckpointStore";
import WorkbenchGitHistoryRewriter, { type WorkbenchGitPreparedHead } from "./WorkbenchGitHistoryRewriter";
import WorkbenchGitRepository, { type GitRefUpdate } from "./WorkbenchGitRepository";
import {
  type ArcOutcome,
  type CheckpointMetadata,
  type GitArcHarness,
  outcomeRef,
  proposalMessage,
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
const STACK_BROKEN_UNAVAILABLE_REASON = "The lower stack layer was not committed as proposed.";

export interface GitCheckpointProposalReceipt {
  baseCommit: string | null;
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
  phase: "active" | "stashed" | "resolved";
  proposals: Array<{ proposalId: string; status: "committed" | "proposed" }>;
  /** Own sealed layers, bottom first; absent means none. */
  stackLayers?: Array<{ layerId: string; proposalIds: string[]; sealedAt: string; title: string }>;
  stashedPaths?: string[];
  threadId: string;
  updatedAt: string;
}

function normalizeHarness(harness: string | undefined): GitArcHarness {
  const parsed = ProviderKeySchema.safeParse(harness ?? "codex");
  if (parsed.success) return parsed.data;
  throw new GitArcRejectionError({ reason: "invalidHarness" }, "A valid checkpoint harness is required.");
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
    phase: entry.phase === "resolved"
      ? "resolved" as const
      : entry.phase === "stashed"
        ? "stashed" as const
        : "active" as const,
    proposalIds: entry.proposalIds ?? (entry.proposalId ? [entry.proposalId] : []),
  };
}

function projectLifecycleState(
  entry: GitArcRegistryEntry,
  lifecycle: NonNullable<ReturnType<typeof lifecycleEntry>>,
  summaries: GitArcProposalSummary[],
  saved: GitArcSavedStash | null | undefined,
  stackLayers: NonNullable<GitArcLifecycleState["stackLayers"]>,
): GitArcLifecycleState {
  const common = {
    checkpointCommit: lifecycle.checkpointCommit,
    harness: entry.harness,
    intentDescription: lifecycle.intentDescription,
    intentName: lifecycle.intentName,
    proposals: summaries.flatMap(({ proposalId, status }) => (
      status === "proposed" || status === "committed" ? [{ proposalId, status }] : []
    )),
    ...(stackLayers.length ? { stackLayers } : {}),
    threadId: entry.threadId,
    updatedAt: entry.updatedAt,
    ...(saved ? { stashedPaths: saved.paths } : {}),
  };
  if (lifecycle.phase === "stashed") {
    return { ...common, claimedPaths: [], phase: "stashed", stashedPaths: lifecycle.claimedPaths };
  }
  if (lifecycle.phase === "resolved") return { ...common, claimedPaths: [], phase: "resolved" };
  return { ...common, claimedPaths: lifecycle.claimedPaths, phase: "active" };
}

function savedLifecycle(entry: GitArcRegistryEntry, saved: GitArcSavedStash | null) {
  const live = lifecycleEntry(entry);
  return saved && (!live || live.phase !== "active" || !live.claimedPaths.length) ? {
    checkpointCommit: saved.checkpointCommit, claimedPaths: saved.paths,
    intentDescription: saved.intentDescription, intentName: saved.intentName,
    phase: "stashed" as const, proposalIds: saved.proposalIds,
  } : live;
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
  throw new GitArcRejectionError({ reason: "proposalNotOwned" }, "The proposal no longer belongs to this thread's active Git arc.");
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
  stack,
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
  stack: GitArcStackController;
  store: GitCheckpointStore;
  threadId: string;
}) {
  // A stack stops shaping the baseline once nothing in its chain is pending after this acceptance.
  const stackTip = active.stackTip && await stack.chainHasPending(await stack.readChain(active.stackTip), proposalId)
    ? commitRemaps?.get(active.stackTip) ?? active.stackTip
    : null;
  const lifecycle = lifecycleEntry(active);
  if (!lifecycle) {
    throw new GitArcRejectionError({ reason: "proposalNotOwned" }, "The proposal no longer belongs to this thread's Git arc.");
  }
  const currentTree = lifecycle.claimedPaths.length
    ? await repository.writeScopedWorktreeTree(lifecycle.claimedPaths, acceptedHead)
    : null;
  const changedPaths = currentTree
    ? await repository.listChangedPaths(acceptedHead, currentTree, lifecycle.claimedPaths)
    : [];
  const claimedPaths = lifecycle.claimedPaths.filter((claimedPath) => (
    changedPaths.some((changedPath) => pathIsCoveredBy(changedPath, claimedPath))
  ));
  const sourceCheckpoint = commitRemaps?.get(source.checkpointCommit) ?? source.checkpointCommit;
  let successorCheckpoint: string | null = null;
  const updates: GitRefUpdate[] = [];
  if (claimedPaths.length) {
    requireArcMetadata(source.metadata);
    const metadata: CheckpointMetadata = {
      amendedFrom: sourceCheckpoint,
      ...(lifecycle.intentDescription ? { intentDescription: lifecycle.intentDescription } : {}),
      ...(lifecycle.intentName ? { intentName: lifecycle.intentName } : {}),
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
  const nextLifecycle: NonNullable<GitArcRegistryEntry["retainedArc"]> = {
    ...lifecycle,
    checkpointCommit: successorCheckpoint ?? sourceCheckpoint,
    claimedPaths,
    phase: claimedPaths.length ? "active" : "resolved",
  };
  const registryMutation = await registry.prepareClaim(active.phase === "plan" ? {
    ...active,
    checkpointCommit: commitRemaps?.get(active.checkpointCommit) ?? active.checkpointCommit,
    retainedArc: nextLifecycle,
    stackTip,
  } : {
    ...active,
    ...nextLifecycle,
    retainedArc: null,
    stackTip,
  }, {
    commitRemaps,
    expectedCheckpointCommit: commitRemaps?.get(active.checkpointCommit) ?? active.checkpointCommit,
    ...(currentTree ? { claimLossSnapshot: { head: acceptedHead, tree: currentTree } } : {}),
  });
  updates.push(...registryMutation.updates);
  return {
    claimedPaths,
    sourceCheckpoint,
    status: claimedPaths.length ? "partial" as const : "committed" as const,
    successorCheckpoint,
    updates,
  };
}

/** Git's raw date form with the local offset, e.g. `1759633402 +1300`. */
function gitRawDate(date: Date) {
  const offset = -date.getTimezoneOffset();
  const magnitude = Math.abs(offset);
  const zone = `${offset < 0 ? "-" : "+"}${String(Math.floor(magnitude / 60)).padStart(2, "0")}${String(magnitude % 60).padStart(2, "0")}`;
  return `${Math.floor(date.getTime() / 1000)} ${zone}`;
}

function commitMessage(title: string, description: string) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new GitArcRejectionError({ reason: "missingCommitTitle" }, "A commit title is required.");
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

async function buildProposalFileChanges(
  proposalDiffs: GitArcProposalDiffController,
  repository: WorkbenchGitRepository,
  metadata: ProposalMetadata,
  targetTree: string,
  options: { baseCommit?: string | null; paths?: string[] } = {},
) {
  const baseCommit = options.baseCommit === undefined ? metadata.baseCommit : options.baseCommit;
  const paths = options.paths ?? metadata.paths;
  const baseTree = await repository.resolveTree(baseCommit);
  return await proposalDiffs.readOrBuild({
    baseTree,
    build: async signal => await repository.buildFileChanges(baseCommit, targetTree, paths, signal),
    paths,
    repositoryRoot: repository.root,
    targetTree,
  });
}

async function buildProposalResult(
  proposalDiffs: GitArcProposalDiffController,
  repository: WorkbenchGitRepository,
  metadata: ProposalMetadata,
  target: { tree: string } | { commit: string },
  options: {
    includeNewerAvailable?: boolean;
    preparedHead?: WorkbenchGitPreparedHead;
    refreshAmendability?: boolean;
    sealedInLayer?: string | null;
    waitingForLayer?: string | null;
  } = {},
): Promise<GitCheckpointProposal> {
  const targetTree = "tree" in target ? target.tree : await repository.resolveTree(target.commit);
  const classifiedAmendability = metadata.status === "committed" && metadata.committedSha
    ? await new WorkbenchGitHistoryRewriter(repository).classifyAmendability(
      metadata.committedSha,
      { preparedHead: options.preparedHead, refresh: options.refreshAmendability ?? true },
    )
    : null;
  const amendability: GitCheckpointProposal["amendability"] = classifiedAmendability?.status === "available"
    ? { status: "available" }
    : classifiedAmendability;
  const [changes, freshChanges, amendTargetMessage] = await Promise.all([
    buildProposalFileChanges(proposalDiffs, repository, metadata, targetTree),
    metadata.mode === "amend" && metadata.status === "proposed" && metadata.freshCommitMessage
      ? buildProposalFileChanges(proposalDiffs, repository, metadata, targetTree, {
        baseCommit: metadata.liveBaseCommit,
        paths: metadata.livePaths,
      })
      : null,
    metadata.amendTargetSha
      ? repository.readCommitMessage(metadata.amendTargetSha).then(parseCommitMessage)
      : null,
  ]);
  return {
    ...(amendability ? { amendability } : {}),
    amendTargetMessage,
    amendTargetSha: metadata.amendTargetSha,
    baseCommit: metadata.baseCommit,
    changes,
    committedSha: metadata.committedSha,
    description: metadata.description,
    freshChanges,
    includeNewerAvailable: options.includeNewerAvailable ?? false,
    unclaimedDirtAvailable: metadata.status === "proposed" && !metadata.messageOnly,
    mode: metadata.mode,
    paths: metadata.paths,
    proposalId: metadata.proposalId,
    sealedInLayer: options.sealedInLayer ?? null,
    status: metadata.status,
    waitingForLayer: metadata.status === "proposed" ? options.waitingForLayer ?? null : null,
    supersededByProposalId: metadata.supersededByProposalId,
    supersededBySha: metadata.supersededBySha,
    title: metadata.title,
    unavailableReason: metadata.unavailableReason,
    unavailableReasonCode: metadata.unavailableReasonCode ?? null,
  };
}

function deriveProposalTransition(
  proposal: StoredProposal,
  metadata: ProposalMetadata,
  treeish?: string,
) {
  return { ...proposal, metadata, tree: treeish ?? proposal.tree };
}

async function persistProposalTransition(
  repository: WorkbenchGitRepository,
  proposal: StoredProposal,
  metadata: ProposalMetadata,
  treeish?: string,
) {
  const tree = treeish ?? proposal.tree;
  const stateCommit = await repository.createCommitFromTree(tree, metadata.baseCommit, proposalMessage(metadata));
  await repository.updateRefs([{ newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef }]);
  return { ...proposal, metadata, proposalCommit: stateCommit, tree };
}

async function resolveProposalState(
  resolveThreadIdentity: GitArcThreadIdentityResolver,
  repository: WorkbenchGitRepository,
  harness: GitArcHarness,
  threadId: string,
  proposalId: string,
  options: {
    includeNewer: boolean;
    persistTransitions: boolean;
    /** Sealed proposals never offer newer work: it belongs to higher stack layers. */
    sealed?: boolean;
    snapshot?: { head: string | null; tree: string };
  },
): Promise<{ currentTree: string | null; includeNewerAvailable: boolean; proposal: StoredProposal; waitingForLayer: string | null }> {
  const store = new GitCheckpointStore(repository, resolveThreadIdentity);
  let proposal = await store.readProposal(harness, threadId, proposalId);
  const applyTransition = async (metadata: ProposalMetadata, treeish?: string) => (
    options.persistTransitions
      ? await persistProposalTransition(repository, proposal, metadata, treeish)
      : deriveProposalTransition(proposal, metadata, treeish)
  );
  if (proposal.metadata.stackBase && proposal.metadata.status === "proposed") {
    const head = options.snapshot ? options.snapshot.head : await repository.headOrNull();
    const stacked = await new GitArcStackController(repository, resolveThreadIdentity).classifyStackedProposal(
      proposal.metadata.stackBase, proposal.metadata.livePaths, head,
      derivedStatusResolver(resolveThreadIdentity, repository, options.snapshot),
    );
    if (stacked.kind === "waiting") {
      return { currentTree: null, includeNewerAvailable: false, proposal, waitingForLayer: stacked.layerTitle };
    }
    if (stacked.kind === "broken") {
      proposal = await applyTransition({
        ...proposal.metadata, status: "unavailable", unavailableReason: STACK_BROKEN_UNAVAILABLE_REASON, unavailableReasonCode: null,
      });
      return { currentTree: null, includeNewerAvailable: false, proposal, waitingForLayer: null };
    }
    // Lower layers landed as sealed; the proposal now sits on real history like any other.
    const { stackBase: _stackBase, ...metadata } = proposal.metadata;
    proposal = await applyTransition(
      { ...metadata, baseCommit: head, liveBaseCommit: head },
      await repository.writeTreeWithPathsFromSource(head, proposal.proposalCommit, proposal.metadata.paths),
    );
  }
  let currentTree: string | null = null;
  const legacyCommittedHistoryReason = proposal.metadata.status === "unavailable"
    && proposal.metadata.unavailableReason?.startsWith("Proposed paths changed in committed history:");
  const branchChangeUnavailable = proposal.metadata.status === "unavailable"
    && proposal.metadata.unavailableReason === BRANCH_CHANGED_UNAVAILABLE_REASON;
  const worktreeChangeUnavailable = proposal.metadata.status === "unavailable"
    && proposal.metadata.livePaths.some(filePath => proposal.metadata.unavailableReason === `${filePath} no longer has working-tree changes.`);
  if (proposal.metadata.status === "proposed" || legacyCommittedHistoryReason || branchChangeUnavailable || worktreeChangeUnavailable) {
    const headMovement = await repository.classifyHeadMovement(proposal.metadata.liveBaseCommit, proposal.metadata.livePaths, proposal.metadata.liveBaseCommit, options.snapshot?.head);
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
    if ((proposal.metadata.status === "proposed" || branchChangeUnavailable || worktreeChangeUnavailable) && canRebaseCommit) {
      const rebasedTree = await repository.writeTreeWithPathsFromSource(
        headMovement.currentHead,
        proposal.proposalCommit,
        proposal.metadata.paths,
      );
      proposal = await applyTransition({
        ...proposal.metadata,
        baseCommit: headMovement.currentHead,
        liveBaseCommit: headMovement.currentHead,
        status: "proposed",
        unavailableReason: null,
        unavailableReasonCode: null,
      }, rebasedTree);
    } else if (proposal.metadata.status === "proposed" && !unavailableReason && headMovement.kind === "fast-forward") {
      proposal = await applyTransition({
        ...proposal.metadata,
        liveBaseCommit: headMovement.currentHead,
      });
    } else if ((branchChangeUnavailable || worktreeChangeUnavailable) && !unavailableReason) {
      proposal = await applyTransition({
        ...proposal.metadata,
        status: "proposed",
        unavailableReason: null,
        unavailableReasonCode: null,
      });
    }
    let changedFromProposal: string[] = [];
    if (proposal.metadata.status === "proposed" && !unavailableReason && !proposal.metadata.messageOnly && !options.sealed) {
      changedFromProposal = options.snapshot
        ? await repository.listChangedPaths(proposal.tree, options.snapshot.tree, proposal.metadata.livePaths)
        : await repository.listWorktreeChangedPaths(proposal.tree, proposal.metadata.livePaths);
    }
    const unavailableReasonCode = committedOutsideProposal ? "committed-outside-proposal" : null;
    if (unavailableReason && (
      proposal.metadata.status !== "unavailable"
      || proposal.metadata.unavailableReason !== unavailableReason
      || proposal.metadata.unavailableReasonCode !== unavailableReasonCode
    )) {
      proposal = await applyTransition({
        ...proposal.metadata,
        status: "unavailable",
        unavailableReason,
        unavailableReasonCode,
      });
    }
    const includeNewerAvailable = proposal.metadata.status === "proposed"
      && changedFromProposal.length > 0;
    if (options.includeNewer && includeNewerAvailable) {
      currentTree = options.snapshot
        ? await repository.writeTreeWithPathsFromSource(proposal.metadata.liveBaseCommit, options.snapshot.tree, proposal.metadata.livePaths)
        : await repository.writeScopedWorktreeTree(
          proposal.metadata.livePaths,
          proposal.metadata.liveBaseCommit,
        );
    }
    return { currentTree, includeNewerAvailable, proposal, waitingForLayer: null };
  }
  return { currentTree, includeNewerAvailable: false, proposal, waitingForLayer: null };
}

/** Stack decisions read derived proposal status without persisting transitions. */
function derivedStatusResolver(
  resolveThreadIdentity: GitArcThreadIdentityResolver,
  repository: WorkbenchGitRepository,
  snapshot?: { head: string | null; tree: string },
): GitArcStackStatusResolver {
  return async (owner, proposalId) => (await resolveProposalState(
    resolveThreadIdentity, repository, normalizeHarness(owner.harness), owner.threadId, proposalId,
    { includeNewer: false, persistTransitions: false, snapshot },
  )).proposal.metadata.status;
}

export default class GitArcProposalController {
  constructor(
    private readonly proposalDiffs = new GitArcProposalDiffController(),
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  private registry(repository: WorkbenchGitRepository) {
    return new GitArcRegistry(repository, this.resolveThreadIdentity);
  }

  private store(repository: WorkbenchGitRepository) {
    return new GitCheckpointStore(repository, this.resolveThreadIdentity);
  }

  private stack(repository: WorkbenchGitRepository) {
    return new GitArcStackController(repository, this.resolveThreadIdentity);
  }

  stackStatusResolver(repository: WorkbenchGitRepository) {
    return derivedStatusResolver(this.resolveThreadIdentity, repository);
  }

  async readStatusProposals(
    input: ArcIdentityInput,
    proposalIds: string[],
    repository: WorkbenchGitRepository,
    snapshot: { head: string | null; tree: string },
  ) {
    const harness = normalizeHarness(input.harness);
    const entry = await this.registry(repository).find({ harness, threadId: input.threadId });
    const layers = await this.stack(repository).readOwnLayers(entry);
    const pending: Array<{ proposalId: string; title: string }> = [];
    const stackedPending = new Map<string, Array<{ proposalId: string; title: string }>>();
    const accepted: Array<{ proposalId: string; title: string; commitSha: string }> = [];
    const unavailable: Array<{ proposalId: string; title: string; reason: string }> = [];
    for (const proposalId of proposalIds) {
      const { proposal } = await resolveProposalState(this.resolveThreadIdentity, repository, harness, input.threadId, proposalId, {
        includeNewer: false, persistTransitions: false, snapshot,
      });
      const metadata = proposal.metadata;
      const layer = layers.find(({ layer: candidate }) => candidate.proposalIds.includes(proposalId));
      if (metadata.status === "proposed") {
        if (layer) stackedPending.set(layer.tipCommit, [...stackedPending.get(layer.tipCommit) ?? [], { proposalId, title: metadata.title }]);
        else pending.push({ proposalId, title: metadata.title });
      }
      if (metadata.status === "committed" && metadata.committedSha) {
        accepted.push({ proposalId, title: metadata.title, commitSha: metadata.committedSha });
      }
      if (metadata.status === "unavailable") {
        unavailable.push({ proposalId, title: metadata.title, reason: metadata.unavailableReason || "This proposal can no longer be committed." });
      }
    }
    const stacked = layers.flatMap(({ layer, tipCommit }) => {
      const layerPending = stackedPending.get(tipCommit);
      return layerPending?.length ? [{ title: layer.title, pending: layerPending }] : [];
    });
    return { pending, accepted, ...(stacked.length ? { stacked } : {}), ...(unavailable.length ? { unavailable } : {}) };
  }

  async listLifecycleStates({ cwd }: { cwd: string }): Promise<GitArcLifecycleState[]> {
    const repository = await WorkbenchGitRepository.tryOpen(cwd);
    if (!repository) return [];
    const entries = await this.registry(repository).list();
    const candidates = entries.map(entry => {
      const saved = entry.savedStash ?? null;
      return { entry, saved, lifecycle: savedLifecycle(entry, saved) };
    });
    const projected = candidates.filter(value => value.lifecycle !== null);
    const stack = this.stack(repository);
    const [summaries, stackLayers] = await Promise.all([
      this.store(repository).readProposalSummaryGroups(projected.map(({ entry, lifecycle }) => ({
        harness: normalizeHarness(entry.harness),
        proposalIds: lifecycle!.proposalIds,
        threadId: entry.threadId,
      }))),
      Promise.all(projected.map(async ({ entry }) => await stack.projectLayers(entry))),
    ]);
    return projected.map(({ entry, lifecycle, saved }, index) => (
      projectLifecycleState(entry, lifecycle!, summaries[index] ?? [], saved, stackLayers[index] ?? [])
    ));
  }

  async findLifecycleState(input: ArcIdentityInput) {
    const repository = await WorkbenchGitRepository.tryOpen(input.cwd);
    if (!repository) return null;
    const harness = normalizeHarness(input.harness);
    const entry = await this.registry(repository).find({ harness, threadId: input.threadId });
    if (!entry) return null;
    const saved = entry.savedStash ?? null;
    const lifecycle = savedLifecycle(entry, saved);
    if (!lifecycle) return null;
    const [summaries, stackLayers] = await Promise.all([
      this.store(repository).readProposalSummaries(harness, input.threadId, lifecycle.proposalIds),
      this.stack(repository).projectLayers(entry),
    ]);
    return projectLifecycleState(entry, lifecycle, summaries, saved, stackLayers);
  }

  /** Commit facts for many proposals from one batched metadata read; unknown ids read as unavailable. */
  async readProposalSummaries(input: ArcIdentityInput & { proposalIds: string[] }) {
    const repository = await WorkbenchGitRepository.tryOpen(input.cwd);
    if (!repository) return [];
    const summaries = await this.store(repository).readProposalSummaries(normalizeHarness(input.harness), input.threadId, input.proposalIds);
    return summaries.map(({ committedSha: _committedSha, ...summary }) => summary);
  }

  async readAcceptedOutcomes(input: ArcIdentityInput & {
    checkpointCommit: string;
    repository?: WorkbenchGitRepository;
    checkpoint?: StoredCheckpoint;
  }) {
    const repository = input.repository ?? await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    return await this.store(repository).readAcceptedOutcomes(
      harness, input.threadId, input.checkpoint ?? input.checkpointCommit,
    );
  }

  async requireNoAcceptedReceipts(input: ArcIdentityInput & { checkpointCommit: string; repository?: WorkbenchGitRepository }) {
    const repository = input.repository ?? await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const store = this.store(repository);
    const outcome = await store.readOutcome(harness, input.threadId, input.checkpointCommit);
    const receipts = outcome?.acceptedProposals ?? [];
    if (receipts.length) {
      const entry = await this.registry(repository).find({ harness, threadId: input.threadId });
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

  /** The commit current arc work is measured from: the pending stack tip, else accepted or checkpoint history. */
  async logicalBaseline(input: ArcIdentityInput & {
    checkpointCommit: string;
    fallbackHead: string | null;
    /** Measure from real history even while stack layers are pending. */
    ignoreStack?: boolean;
    repository?: WorkbenchGitRepository;
  }) {
    const repository = input.repository ?? await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    if (!input.ignoreStack) {
      const tip = await this.stack(repository).pendingTip(await this.registry(repository).find({ harness, threadId: input.threadId }));
      if (tip) return tip;
    }
    const outcome = await this.store(repository).readOutcome(harness, input.threadId, input.checkpointCommit);
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
    const store = this.store(repository);
    const target = await store.readProposal(harness, threadId, amendProposalId);
    if (target.metadata.status !== "committed" || !target.metadata.committedSha) {
      throw new GitArcRejectionError({ reason: "proposalRequiresCommittedTarget" }, "A targeted message amend requires a committed proposal.");
    }
    const amendability = await new WorkbenchGitHistoryRewriter(repository).classifyAmendability(target.metadata.committedSha);
    if (amendability.status === "unavailable") throw new GitArcRejectionError({ reason: "proposalUnavailable" }, amendability.reason);
    const inherited = parseCommitMessage(await repository.readCommitMessage(amendability.resolvedTarget));
    const proposalTitle = title.trim() || inherited.title;
    const proposalDescription = title.trim() ? description.trim() : inherited.description;
    commitMessage(proposalTitle, proposalDescription);
    if (proposalTitle === inherited.title && proposalDescription === inherited.description) {
      throw new GitArcRejectionError({ reason: "unchangedMessage" }, "The proposed commit message is unchanged.");
    }

    const source = await store.readCheckpoint(harness, threadId, target.metadata.sourceCheckpoint);
    const sourceMetadata = requireArcMetadata(source.metadata);
    const registry = this.registry(repository);
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
      { newValue: proposalCommit, oldValue: "0".repeat(40), ref: await store.proposalRefName(harness, threadId, proposalId) },
      ...registryMutation.updates,
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
    freshDescription,
    freshTitle,
    harness: rawHarness,
    paths: rawPaths,
    replaceProposalId,
    threadId,
    title,
  }: ArcIdentityInput & {
    amend?: boolean;
    amendProposalId?: string;
    description: string;
    freshDescription?: string;
    freshTitle?: string;
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
    const { active, arc, checkpoint, claimedPaths, harness, metadata: checkpointMetadata, proposalIds, registry, repository } = await this.requireProposableArc({ cwd, harness: rawHarness, threadId });
    const store = this.store(repository);
    const stack = this.stack(repository);
    const [stackTip, sealedIds] = await Promise.all([stack.pendingTip(active), stack.sealedProposalIds(active)]);
    if (stackTip && (amend || amendProposalId)) throw new GitArcRejectionError({ reason: "amendOnPendingStack" });
    if (replaceProposalId && sealedIds.has(replaceProposalId)) throw new GitArcRejectionError({ reason: "sealedProposal" });
    let replacementTarget: StoredProposal | null = null;
    if (replaceProposalId) {
      replacementTarget = await store.readProposal(harness, threadId, replaceProposalId);
      if (replacementTarget.metadata.status === "committed") {
        throw proposalAlreadyCommitted(replacementTarget);
      }
      if (replacementTarget.metadata.status !== "proposed" && replacementTarget.metadata.status !== "unavailable") {
        throw new GitArcRejectionError({ reason: "proposalCannotBeReplaced" }, "Only a pending or unavailable proposal can be replaced.");
      }
    }
    let amendTargetProposal: StoredProposal | null = null;
    if (amendProposalId) {
      amendTargetProposal = await store.readProposal(harness, threadId, amendProposalId);
      if (amendTargetProposal.metadata.status !== "committed" || !amendTargetProposal.metadata.committedSha) {
        throw new GitArcRejectionError({ reason: "proposalRequiresCommittedTarget" }, "A targeted amend requires a committed proposal.");
      }
      amend = true;
    }
    const requestedPaths = rawPaths?.length
      ? repository.normalizePaths(rawPaths)
      : repository.normalizePaths(claimedPaths);
    if (rawPaths?.length) {
      const outsideClaim = requestedPaths.filter((candidate) => (
        !claimedPaths.some((scopePath) => pathIsCoveredBy(candidate, scopePath))
      ));
      if (outsideClaim.length) throw new GitArcRejectionError({ reason: "pathsOutsideClaims", paths: outsideClaim }, `Proposed paths must stay within the arc's claimed set: ${outsideClaim.join(", ")}`);
    }
    let liveBaseCommit: string | null;
    if (stackTip) {
      // Stacked proposals build on sealed layers, which real HEAD only gains as the user commits them.
      await stack.validateBaseline(stackTip, requestedPaths, await repository.headOrNull());
      liveBaseCommit = stackTip;
    } else {
      const logicalBaseline = (await store.readOutcome(harness, threadId, checkpoint.checkpointCommit))?.acceptedProposals?.at(-1)?.headSha
        ?? checkpoint.parent;
      const headMovement = await repository.classifyHeadMovement(logicalBaseline, requestedPaths, logicalBaseline);
      if (headMovement.kind === "incompatible") {
        throw new GitArcRejectionError({ reason: "incompatibleHead" }, "Repository HEAD moved incompatibly after this arc began. Create a new plan before proposing a commit.");
      }
      if (headMovement.changedPaths.length) {
        throw new GitArcRejectionError({ reason: "baselineChanged", paths: headMovement.changedPaths }, `Proposed paths no longer match the arc baseline: ${headMovement.changedPaths.join(", ")}`);
      }
      liveBaseCommit = headMovement.currentHead;
    }
    if (amend && liveBaseCommit === null) throw new Error("An amend requires an existing HEAD commit.");
    const requestedAmendTarget = amendTargetProposal?.metadata.committedSha ?? (amend ? liveBaseCommit : null);
    let amendTargetSha: string | null = null;
    if (requestedAmendTarget) {
      const publish = new GitArcPublishState(repository);
      const publishState = amendTargetProposal
        ? await publish.classifyCommit(requestedAmendTarget)
        : await publish.classifyCurrentHead();
      if (publishState.kind === "pushed" && freshTitle?.trim()) {
        // Pushed targets cannot be amended; keep only the fresh-commit choice so agents never need to pre-check.
        title = freshTitle;
        description = freshDescription ?? "";
      } else {
        GitArcPublishState.requireUnpushed(publishState, amendTargetProposal ? "Commit" : "Current HEAD");
        amendTargetSha = requestedAmendTarget;
      }
    }
    const baseCommit = amendTargetSha ? await repository.resolveParent(amendTargetSha) : liveBaseCommit;
    const proposalTree = await repository.writeScopedWorktreeTree(requestedPaths, amendTargetSha ?? liveBaseCommit);
    const livePaths = await repository.listChangedPaths(liveBaseCommit, proposalTree, requestedPaths);
    if (!livePaths.length) throw new GitArcRejectionError({ reason: "noChangesToPropose" }, "The selected arc paths do not contain any working-tree changes to propose.");
    // Sealed proposals may overlap: later layers deliberately build on their files.
    await this.requireNoPendingOverlap(repository, harness, threadId, proposalIds.filter(id => id !== replaceProposalId && !sealedIds.has(id)), livePaths);
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
      ...(amendTargetSha && freshTitle ? {
        freshCommitMessage: {
          description: freshDescription?.trim() ?? "",
          title: freshTitle.trim(),
        },
      } : {}),
      liveBaseCommit,
      livePaths,
      mode: amendTargetSha ? "amend" : "commit",
      paths,
      proposalId,
      proposedAt: gitRawDate(new Date()),
      sourceCheckpoint: checkpoint.checkpointCommit,
      ...(stackTip ? { stackBase: stackTip } : {}),
      status: "proposed",
      supersededByProposalId: null,
      supersededBySha: null,
      title: proposalTitle,
      unavailableReason: null,
      version: 2,
    };
    commitMessage(metadata.title, metadata.description);
    const proposalCommit = await repository.createCommitFromTree(proposalTree, baseCommit, proposalMessage(metadata));
    await buildProposalFileChanges(this.proposalDiffs, repository, metadata, proposalTree);
    // A replacement takes its target's place, so superseded proposals never linger in the thread's list.
    const nextProposalIds = replaceProposalId && proposalIds.includes(replaceProposalId)
      ? proposalIds.map(id => id === replaceProposalId ? proposalId : id)
      : [...proposalIds, proposalId];
    const registryMutation = await registry.prepareSet({
      ...active,
      ...(active.phase === "plan" ? {
        retainedArc: {
          ...arc,
          phase: "active" as const,
          proposalIds: nextProposalIds,
        },
      } : {
        proposalId,
        proposalIds: nextProposalIds,
      }),
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
      { newValue: proposalCommit, oldValue: "0".repeat(40), ref: await store.proposalRefName(harness, threadId, proposalId) },
      ...registryMutation.updates,
    ]);
    return {
      baseCommit,
      description: metadata.description,
      intentName: checkpointMetadata.intentName ?? null,
      paths: metadata.paths,
      proposalId,
      scopePaths: claimedPaths,
      sourceCheckpoint: checkpoint.checkpointCommit,
      title: metadata.title,
    };
  }

  /** Pending proposals in one thread must stay independently committable, so their live paths never overlap. */
  private async requireNoPendingOverlap(
    repository: WorkbenchGitRepository,
    harness: GitArcHarness,
    threadId: string,
    proposalIds: string[],
    livePaths: string[],
  ) {
    for (const proposalId of proposalIds) {
      const { proposal } = await resolveProposalState(this.resolveThreadIdentity, repository, harness, threadId, proposalId, {
        includeNewer: false, persistTransitions: false,
      });
      if (proposal.metadata.status !== "proposed") continue;
      const overlapping = livePaths.filter(candidate => (
        proposal.metadata.livePaths.some(pending => gitArcPathsOverlap(candidate, pending))
      ));
      if (!overlapping.length) continue;
      throw new GitArcRejectionError(
        { reason: "pathsInPendingProposal", paths: overlapping },
        `Proposed paths are already in pending proposal ${proposalId}: ${overlapping.join(", ")}. Stack it to build on it, replace it, rescind it, or propose explicit paths that exclude them.`,
      );
    }
  }

  private async unclaimedPaths(repository: WorkbenchGitRepository, snapshot: { head: string | null; tree: string }, excludedPaths: string[]) {
    const [changedPaths, entries] = await Promise.all([
      repository.listAllChangedPaths(snapshot.head, snapshot.tree),
      this.registry(repository).list(),
    ]);
    const excluded = [...excludedPaths, ...entries.flatMap(getGitArcLiveClaimPaths)];
    return changedPaths.filter(candidate => !excluded.some(claim => gitArcPathsOverlap(candidate, claim)));
  }

  async getProposal({ cwd, harness: rawHarness, includeNewer, includeUnclaimed, proposalId, threadId }: ArcIdentityInput & { includeNewer: boolean; includeUnclaimed?: boolean; proposalId: string }) {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const snapshot = includeUnclaimed ? await repository.writeWorktreeSnapshot() : undefined;
    const sealingLayer = await this.sealingLayer(repository, harness, threadId, proposalId);
    const { currentTree, includeNewerAvailable, proposal, waitingForLayer } = await resolveProposalState(
      this.resolveThreadIdentity,
      repository,
      harness,
      threadId,
      proposalId,
      { includeNewer, persistTransitions: false, sealed: Boolean(sealingLayer), snapshot },
    );
    const target = (proposal.metadata.status === "committed" || proposal.metadata.status === "superseded") && proposal.metadata.committedSha
      ? { commit: proposal.metadata.committedSha }
      : includeNewer && includeNewerAvailable && currentTree
        ? { tree: currentTree }
        : { tree: proposal.tree };
    const result = await buildProposalResult(this.proposalDiffs, repository, proposal.metadata, target, {
      includeNewerAvailable,
      refreshAmendability: false,
      sealedInLayer: sealingLayer?.title ?? null,
      waitingForLayer,
    });
    if (!snapshot || !result.unclaimedDirtAvailable) return result;
    const paths = await this.unclaimedPaths(repository, snapshot, proposal.metadata.paths);
    const changes = paths.length ? await buildProposalFileChanges(this.proposalDiffs, repository, proposal.metadata, snapshot.tree, {
      baseCommit: snapshot.head, paths,
    }) : [];
    return { ...result, unclaimedDirt: { changes, tree: snapshot.tree } };
  }

  async getProposalPaths({ cwd, harness: rawHarness, proposalId, threadId }: ArcIdentityInput & { proposalId: string }) {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const proposal = await this.store(repository).readProposal(harness, threadId, proposalId);
    return [...proposal.metadata.paths];
  }

  private async sealingLayer(repository: WorkbenchGitRepository, harness: GitArcHarness, threadId: string, proposalId: string) {
    return await this.stack(repository).sealingLayer(await this.registry(repository).find({ harness, threadId }), proposalId);
  }

  async rescindProposal(input: ArcIdentityInput & { proposalId: string }) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    if (await this.sealingLayer(repository, harness, input.threadId, input.proposalId)) {
      throw new GitArcRejectionError({ reason: "sealedProposal" }, "Sealed proposals cannot be rescinded. Unstack the top layer first when nothing builds on it.");
    }
    const proposal = await this.store(repository).readProposal(harness, input.threadId, input.proposalId);
    if (proposal.metadata.status === "committed") {
      throw proposalAlreadyCommitted(proposal);
    }
    if (proposal.metadata.status !== "proposed") throw new GitArcRejectionError({ reason: "proposalCannotBeRescinded" }, "Only a pending proposal can be rescinded.");
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
    if (!target) throw new GitArcRejectionError({ reason: "messageAmendRequiresTarget" }, "A message amendment requires an exact committed target.");
    const message = commitMessage(title, description);
    if (message.trim() === (await repository.readCommitMessage(target)).trim()) {
      throw new GitArcRejectionError({ reason: "unchangedMessage" }, "The amended commit message is unchanged.");
    }
    const store = this.store(repository);
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
        expectedHead: proposal.metadata.status === "proposed" ? proposal.metadata.liveBaseCommit ?? undefined : undefined,
        message,
        metadataOnly: true,
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
    return await buildProposalResult(this.proposalDiffs, repository, committedMetadata, { commit: amendedCommit });
  }

  async commitProposal({
    cwd,
    description,
    harness: rawHarness,
    includeNewer,
    unclaimedSelection,
    mode,
    proposalId,
    threadId,
    title,
  }: ArcIdentityInput & {
    description: string;
    includeNewer: boolean;
    unclaimedSelection?: Extract<GitCheckpointRequest, { action: "proposalCommit" }>["unclaimedSelection"];
    mode?: "amend" | "commit";
    proposalId: string;
    title: string;
  }): Promise<GitCheckpointProposal> {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const snapshot = unclaimedSelection ? await repository.writeWorktreeSnapshot() : undefined;
    // Newer work above a sealed proposal belongs to higher layers, so sealed commits never include it.
    const sealed = Boolean(await this.sealingLayer(repository, harness, threadId, proposalId));
    if (sealed) includeNewer = false;
    const resolved = await resolveProposalState(
      this.resolveThreadIdentity,
      repository,
      harness,
      threadId,
      proposalId,
      { includeNewer, persistTransitions: true, sealed, snapshot },
    );
    if (resolved.waitingForLayer) {
      throw new GitArcRejectionError({ reason: "proposalUnavailable" }, `Commit the lower stack layer "${resolved.waitingForLayer}" first.`);
    }
    let proposal = resolved.proposal;
    if (unclaimedSelection && snapshot) {
      if (proposal.metadata.status !== "proposed" || proposal.metadata.messageOnly) {
        throw new GitArcRejectionError({ reason: "proposalUnavailable" }, "This proposal cannot include unclaimed changes.");
      }
      const paths = repository.normalizePaths(unclaimedSelection.paths);
      const eligible = new Set(await this.unclaimedPaths(repository, snapshot, proposal.metadata.paths));
      const unavailable = paths.filter(candidate => !eligible.has(candidate));
      if (!paths.length || unavailable.length) {
        throw new GitArcRejectionError({ reason: "adoptionRequiresUnclaimed", paths: unavailable }, "Selected files must still be dirty and unclaimed. Inspect the unclaimed changes again.");
      }
      const changed = await repository.listChangedPaths(unclaimedSelection.tree, snapshot.tree, paths);
      if (changed.length) {
        throw new GitArcRejectionError({ reason: "baselineChanged", paths: changed }, "Selected unclaimed files changed after inspection. Inspect them again before committing.");
      }
      proposal = {
        ...proposal,
        tree: await repository.writeTreeWithPathsFromSource(proposal.tree, snapshot.tree, paths),
        metadata: {
          ...proposal.metadata,
          paths: [...new Set([...proposal.metadata.paths, ...paths])].sort(),
          livePaths: [...new Set([...proposal.metadata.livePaths, ...paths])].sort(),
        },
      };
      if (resolved.currentTree) {
        resolved.currentTree = await repository.writeTreeWithPathsFromSource(resolved.currentTree, snapshot.tree, paths);
      }
    }
    if (proposal.metadata.status === "committed") {
      return await this.commitMessageAmendment({ description, harness, proposal, repository, threadId, title });
    }
    if (proposal.metadata.status !== "proposed") {
      throw new GitArcRejectionError({ reason: "proposalUnavailable" }, proposal.metadata.unavailableReason || "Checkpoint proposal is not available to commit.");
    }
    if (proposal.metadata.messageOnly) {
      if (mode === "commit") throw new GitArcRejectionError({ reason: "messageAmendCannotCommitFresh" }, "Message-only amendment proposals cannot be committed fresh.");
      return await this.commitMessageAmendment({ description, harness, proposal, repository, threadId, title });
    }
    const selectedMode = mode ?? proposal.metadata.mode;
    if (selectedMode === "amend" && proposal.metadata.mode !== "amend") {
      throw new GitArcRejectionError({ reason: "cannotCommitAsAmend" }, "Only amend proposals can be accepted as amendments.");
    }
    if (
      selectedMode === "commit"
      && proposal.metadata.mode === "amend"
      && !proposal.metadata.freshCommitMessage
    ) {
      throw new GitArcRejectionError({ reason: "missingFreshCommitChoice" }, "This amend proposal does not include a fresh commit choice.");
    }
    const store = this.store(repository);
    const proposalSource = await store.readCheckpoint(harness, threadId, proposal.metadata.sourceCheckpoint);
    requireArcMetadata(proposalSource.metadata);
    const registry = this.registry(repository);
    const active = await registry.find({ harness, threadId });
    const lifecycle = active ? lifecycleEntry(active) : null;
    if (!active || !lifecycle) {
      throw new GitArcRejectionError({ reason: "proposalNotOwned" }, "The proposal no longer belongs to this thread's Git arc.");
    }
    const activeSource = lifecycle.checkpointCommit === proposalSource.checkpointCommit
      ? proposalSource
      : await store.readCheckpoint(harness, threadId, lifecycle.checkpointCommit);
    const activeChain = await readArcChain(store, harness, threadId, activeSource, proposalSource.checkpointCommit);
    const previousAcceptedProposals = await readAcceptedReceipts(store, harness, threadId, activeChain);
    if (selectedMode === "amend") {
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
          expectedHead: proposal.metadata.liveBaseCommit ?? undefined,
          message,
          paths: proposal.metadata.livePaths,
          target: proposal.metadata.amendTargetSha,
          targetTree,
          mutatePlan: async ({ amendedCommit, arcPlan, headRef, newHead }) => {
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
            stack: this.stack(repository),
            store,
            threadId,
          });
          for (const update of transition.updates) {
            updates.push(update);
            if (update.ref.endsWith("/claim-loss")) replaceRefs.push(update.ref);
          }
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
          committedResult = await buildProposalResult(this.proposalDiffs, repository, committedMetadata, { tree: targetTree }, {
            preparedHead: { commit: newHead, ref: headRef },
          });
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
    const committingFresh = proposal.metadata.mode === "amend";
    const baseCommit = committingFresh ? proposal.metadata.liveBaseCommit : proposal.metadata.baseCommit;
    const selectedTree = includeNewer && resolved.includeNewerAvailable ? resolved.currentTree! : proposal.tree;
    const targetTree = committingFresh && !(includeNewer && resolved.includeNewerAvailable)
      ? await repository.writeTreeWithPathsFromSource(baseCommit, selectedTree, proposal.metadata.livePaths)
      : selectedTree;
    if (targetTree === await repository.resolveTree(baseCommit)) {
      throw new GitArcRejectionError({ reason: "noChangesToPropose" }, "The selected result has no changes to commit.");
    }
    // Commits land at their proposal time so accepted stacks keep their real history; newer work is dated now.
    const proposedAt = includeNewer && resolved.includeNewerAvailable ? undefined : proposal.metadata.proposedAt;
    const committedSha = await repository.createCommitFromTree(targetTree, baseCommit, message,
      proposedAt ? { authorDate: proposedAt, committerDate: proposedAt } : undefined);
    const { freshCommitMessage: _freshCommitMessage, ...proposalMetadata } = proposal.metadata;
    const committedMetadata: ProposalMetadata = {
      ...proposalMetadata,
      ...(committingFresh ? {
        amendTargetSha: null,
        baseCommit,
        mode: "commit" as const,
        paths: proposal.metadata.livePaths,
      } : {}),
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
      stack: this.stack(repository),
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
    const headRef = await repository.symbolicHead();
    const result = await buildProposalResult(this.proposalDiffs, repository, committedMetadata, { tree: targetTree }, {
      preparedHead: { commit: committedSha, ref: headRef },
    });
    try {
      await repository.publishRefsAfterIndexNormalization({
        indexCommit: committedSha,
        paths: proposal.metadata.livePaths,
        updates: [
          { newValue: committedSha, oldValue: proposal.metadata.liveBaseCommit ?? "0".repeat(committedSha.length), ref: headRef ?? "HEAD" },
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
    repository: existingRepository,
    threadId,
  }: ArcIdentityInput & { proposalIds: string[]; reason: string; repository?: WorkbenchGitRepository }) {
    const repository = existingRepository ?? await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const store = this.store(repository);
    const invalidations = await Promise.all(proposalIds.map(async (proposalId) => {
      const proposal = await store.readProposal(harness, threadId, proposalId);
      if (proposal.metadata.status !== "proposed") return null;
      const stateCommit = await repository.createCommitFromTree(
        proposal.tree,
        proposal.metadata.baseCommit,
        proposalMessage({ ...proposal.metadata, status: "unavailable", unavailableReason: reason }),
      );
      const update: GitRefUpdate = { newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef };
      return { proposalId, update };
    }));
    const applied = invalidations.filter(entry => entry !== null);
    // Callers report invalidated proposals so they never vanish silently.
    return {
      updates: applied.map(({ update }) => update),
      invalidatedProposals: applied.map(({ proposalId }) => ({ proposalId, reason })),
    };
  }

  /** Pending proposals whose live paths intersect the given paths. */
  async proposalsCoveringPaths(repository: WorkbenchGitRepository, harness: string, threadId: string, proposalIds: string[], paths: string[]) {
    const store = this.store(repository);
    const covering = await Promise.all(proposalIds.map(async (proposalId) => {
      const proposal = await store.readProposal(normalizeHarness(harness), threadId, proposalId);
      return proposal.metadata.livePaths.some(live => paths.some(candidate => gitArcPathsOverlap(live, candidate))) ? proposalId : null;
    }));
    return covering.filter(id => id !== null);
  }

  private async requireProposableArc(input: ArcIdentityInput) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = this.registry(repository);
    const active = await registry.find({ harness, threadId: input.threadId });
    const arc = active?.phase === "plan" ? active.retainedArc : active;
    if (!active || !arc || arc.phase !== "active" || !arc.claimedPaths.length) {
      throw new GitArcRejectionError({ reason: "missingActiveArc" }, "This thread does not own active Git arc claims.");
    }
    const checkpoint = await this.store(repository).readCheckpoint(harness, input.threadId, arc.checkpointCommit);
    const metadata = requireArcMetadata(checkpoint.metadata);
    const claimsMatch = active.phase === "plan"
      ? arc.claimedPaths.every((claimedPath) => metadata.scopePaths.includes(claimedPath))
      : metadata.scopePaths.length === arc.claimedPaths.length
        && metadata.scopePaths.every((scopePath, index) => scopePath === arc.claimedPaths[index]);
    if (!claimsMatch) {
      throw new Error("The Git arc registry does not match its checkpoint claim set.");
    }
    return {
      active,
      arc,
      checkpoint,
      claimedPaths: arc.claimedPaths,
      harness,
      metadata,
      proposalIds: arc.proposalIds ?? (active.proposalId ? [active.proposalId] : []),
      registry,
      repository,
    };
  }
}
