/*
 * Exports:
 * - default GitArcProposalController: own proposal validity (including stacked proposals), bounded diff hydration, publication, acceptance (fresh-commit runs as one transaction), and lifecycle projection.
 * - GitArcLifecycleState: active or resolved arc with ordered proposals, their paths and Git-derived summaries (change totals, not per-file lists).
 * - GitArcDurableProposalReader: accepted proposal ids each thread already holds in permanent commit history.
 * - GitArcAcceptedProposalsError: accepted receipts and remaining claims when continuation stops.
 * - GitCheckpointProposalReceipt: published proposal identity.
 */
import { randomUUID } from "node:crypto";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";

import type { GitArcProposalCommitEntry, GitCheckpointProposal, GitCheckpointRequest } from "workbench-shared/workbench/git/checkpoint-contracts";
import { GitArcMissingClaimSetError, GitArcProposalAlreadyCommittedError } from "workbench-shared/workbench/git/git-arc-failures";
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import GitObjectReadSession from "./GitObjectReadSession";
import type { GitArcSavedStash } from "workbench-shared/workbench/git/git-arc-storage";
import type { WorkbenchGitArcProposalSummary } from "workbench-shared/workbench/thread/thread-state";
import { summarizeGitArcChanges } from "workbench-shared/workbench/git/git-arc-change-totals";
import GitArcProposalDiffController from "./GitArcProposalDiffController";
import {
  passthroughGitArcThreadIdentityResolver,
  type GitArcThreadIdentityResolver,
} from "./git-arc-thread-identity";
import GitArcPublishState from "./GitArcPublishState";
import GitArcClaimOwnershipController from "./GitArcClaimOwnershipController";
import GitArcRegistry, { REGISTRY_REF, getGitArcLiveClaimPaths, type GitArcRegistryEntry } from "./GitArcRegistry";
import GitArcStackController, { type GitArcStackStatusResolver } from "./GitArcStackController";
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import GitCheckpointStore, {
  type GitArcProposalSummary,
  type StoredCheckpoint,
  type StoredProposal,
} from "./GitCheckpointStore";
import freshCommitProposal from "./fresh-commit-proposal";
import { formatGitRawDate } from "./GitObjectWriter";
import WorkbenchGitHistoryRewriter, { type WorkbenchGitCommitAmendability, type WorkbenchGitPreparedHead } from "./WorkbenchGitHistoryRewriter";
import WorkbenchGitRepository, { type GitRefUpdate, type GitWorktreeSnapshot } from "./WorkbenchGitRepository";
import {
  type ArcOutcome,
  type CheckpointMetadata,
  type GitArcHarness,
  outcomeRef,
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

/** One fresh commit prepared in memory on its batch's running head. */
interface CommitLanding {
  committedMetadata: ProposalMetadata;
  committedSha: string;
  proposal: StoredProposal;
  stateCommit: string;
  targetTree: string;
}

/** Consecutive fresh-commit acceptances that publish together; nothing they read is published before them. */
interface CommitBatch {
  accepted: NonNullable<ArcOutcome["acceptedProposals"]>;
  acceptedIds: Set<string>;
  active: GitArcRegistryEntry;
  activeSource: StoredCheckpoint;
  head: string | null;
  landings: CommitLanding[];
  startHead: string | null;
  worktree: GitWorktreeSnapshot;
}

/** A landing rejected because its proposal just became unavailable; that state persists once earlier landings publish. */
class UnavailableLandingError extends GitArcRejectionError {
  constructor(readonly proposal: StoredProposal) {
    super({ reason: "proposalUnavailable" }, proposal.metadata.unavailableReason || "Checkpoint proposal is not available to commit.");
  }
}

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

/** Accepted proposal ids each thread already holds in permanent commit history; lifecycle reads leave them out. */
export type GitArcDurableProposalReader = (threadIds: readonly string[]) => Promise<ReadonlyMap<string, ReadonlySet<string>>>;

export interface GitArcLifecycleState {
  checkpointCommit: string;
  claimedPaths: string[];
  harness: string;
  intentDescription: string;
  intentName: string;
  phase: "active" | "stashed" | "resolved";
  /** `paths` lets workspace aggregation place each proposal in a root without another read; it is not published. */
  proposals: Array<{ paths: string[]; proposalId: string; status: "committed" | "proposed"; summary: WorkbenchGitArcProposalSummary }>;
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

/** Stored accepted visibility, pruned to the lifecycle's own proposals. */
function acceptedVisibility(entry: GitArcRegistryEntry) {
  const ids = new Set(lifecycleEntry(entry)?.proposalIds ?? []);
  return {
    dismissed: (entry.acceptedVisibility?.dismissed ?? []).filter(id => ids.has(id)),
    viewed: (entry.acceptedVisibility?.viewed ?? []).filter(id => ids.has(id)),
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
    proposals: summaries.flatMap(({ changes, committedAt, committedSha, description, mode, paths, proposalId, replacedSha, status, title }) => (
      status === "proposed" || status === "committed"
        ? [{
          paths, proposalId, status,
          summary: {
            ...(committedAt ? { committedAt } : {}), committedSha, description, mode,
            ...(replacedSha ? { replacedSha } : {}), title, totals: changes ? summarizeGitArcChanges(changes) : null,
          },
        }]
        : []
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

/** Proposals a lifecycle publishes: its sealed and own ids, less accepted ones already in permanent history. */
function projectedProposalIds(
  lifecycle: NonNullable<ReturnType<typeof lifecycleEntry>>,
  stackLayers: NonNullable<GitArcLifecycleState["stackLayers"]>,
  durable: ReadonlySet<string> = new Set(),
) {
  return [...new Set([...stackLayers.flatMap(({ proposalIds }) => proposalIds), ...lifecycle.proposalIds])]
    .filter(proposalId => !durable.has(proposalId));
}

function lifecycleSummaries(
  committed: readonly GitArcProposalSummary[],
  current: readonly GitArcProposalSummary[],
) {
  const currentIds = new Set(current.map(({ proposalId }) => proposalId));
  return [
    ...committed.filter(({ proposalId }) => !currentIds.has(proposalId)),
    ...current,
  ];
}

function savedLifecycle(entry: GitArcRegistryEntry, saved: GitArcSavedStash | null) {
  const live = lifecycleEntry(entry);
  return saved && (!live || live.phase !== "active" || !live.claimedPaths.length) ? {
    checkpointCommit: saved.checkpointCommit, claimedPaths: saved.paths,
    intentDescription: saved.intentDescription, intentName: saved.intentName,
    phase: "stashed" as const, proposalIds: saved.proposalIds,
  } : live;
}

function replaceProposalId(values: readonly string[], target: string, replacement: string) {
  return values.map(id => id === target ? replacement : id);
}

function revisedRegistryEntry(
  entry: GitArcRegistryEntry,
  target: string,
  replacement: string,
  commits: ReadonlyMap<string, string>,
): Omit<GitArcRegistryEntry, "updatedAt"> {
  const targetIsStored = [
    ...(entry.proposalIds ?? []),
    ...(entry.retainedArc?.proposalIds ?? []),
    ...(entry.savedStash?.proposalIds ?? []),
  ].includes(target);
  const proposalIds = targetIsStored
    ? replaceProposalId(entry.proposalIds ?? [], target, replacement)
    : [...(entry.proposalIds ?? []), replacement];
  return {
    ...entry,
    checkpointCommit: commits.get(entry.checkpointCommit) ?? entry.checkpointCommit,
    proposalId: proposalIds.at(-1) ?? null,
    proposalIds,
    ...(entry.stackTip ? { stackTip: commits.get(entry.stackTip) ?? entry.stackTip } : {}),
    ...(entry.retainedArc ? {
      retainedArc: {
        ...entry.retainedArc,
        checkpointCommit: commits.get(entry.retainedArc.checkpointCommit) ?? entry.retainedArc.checkpointCommit,
        proposalIds: replaceProposalId(entry.retainedArc.proposalIds, target, replacement),
      },
    } : {}),
    ...(entry.savedStash ? {
      savedStash: {
        ...entry.savedStash,
        checkpointCommit: commits.get(entry.savedStash.checkpointCommit) ?? entry.savedStash.checkpointCommit,
        proposalIds: replaceProposalId(entry.savedStash.proposalIds, target, replacement),
      },
    } : {}),
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

async function prepareAcceptedClaimTransition({
  acceptedHead,
  commitRemaps,
  harness,
  proposalIds,
  registry,
  resolveThreadIdentity,
  repository,
  source,
  stack,
  store,
  threadId,
}: {
  acceptedHead: string;
  commitRemaps?: ReadonlyMap<string, string>;
  harness: GitArcHarness;
  /** Every proposal this transition accepts, in landing order. */
  proposalIds: readonly string[];
  registry: GitArcRegistry;
  resolveThreadIdentity: GitArcThreadIdentityResolver;
  repository: WorkbenchGitRepository;
  source: StoredCheckpoint;
  stack: GitArcStackController;
  store: GitCheckpointStore;
  threadId: string;
}) {
  const current = await registry.find({ harness, threadId });
  if (!current) {
    throw new GitArcRejectionError({ reason: "proposalNotOwned" }, "The proposal no longer belongs to this thread's Git arc.");
  }
  const accepted = new Set(proposalIds);
  // A stack stops shaping the baseline once nothing in its chain is pending after this acceptance.
  const stackTip = current.stackTip && await stack.chainHasPending(await stack.readChain(current.stackTip), accepted)
    ? commitRemaps?.get(current.stackTip) ?? current.stackTip
    : null;
  const lifecycle = lifecycleEntry(current);
  if (!lifecycle) {
    throw new GitArcRejectionError({ reason: "proposalNotOwned" }, "The proposal no longer belongs to this thread's Git arc.");
  }
  const currentTree = lifecycle.claimedPaths.length
    ? await repository.writeScopedWorktreeTree(lifecycle.claimedPaths, acceptedHead)
    : null;
  const ownership = new GitArcClaimOwnershipController(repository, resolveThreadIdentity);
  const before = await ownership.project(current, currentTree);
  const changedPaths = currentTree ? await repository.listChangedPaths(acceptedHead, currentTree, before.activeClaims) : [];
  const activeClaimedPaths = changedPaths.length ? before.activeClaims : [];
  const currentGuards = new GitArcPathSet(before.guardClaims);
  const baselineClaims = (await stack.pendingOwnBaselinePaths(current, accepted))
    .filter(path => currentGuards.covers(path));
  const claimedPaths = [...new Set([...activeClaimedPaths, ...baselineClaims])]
    .sort((left, right) => left.localeCompare(right));
  const sourceCheckpoint = commitRemaps?.get(source.checkpointCommit) ?? source.checkpointCommit;
  let successorCheckpoint: string | null = null;
  const updates: GitRefUpdate[] = [];
  // A claim-free acceptance hides every accepted proposal status already showed.
  const visibility = acceptedVisibility(current);
  const dismissal = claimedPaths.length ? {} : {
    acceptedVisibility: { dismissed: [...new Set([...visibility.dismissed, ...visibility.viewed])], viewed: [] },
  };
  if (claimedPaths.length) {
    requireArcMetadata(source.metadata);
    const metadata: CheckpointMetadata = {
      amendedFrom: sourceCheckpoint,
      ...(lifecycle.intentDescription ? { intentDescription: lifecycle.intentDescription } : {}),
      ...(lifecycle.intentName ? { intentName: lifecycle.intentName } : {}),
      kind: "arc",
      priorProposalId: proposalIds.at(-1)!,
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
    activeClaimedPaths,
    claimedPaths,
    phase: claimedPaths.length ? "active" : "resolved",
  };
  const registryMutation = await registry.prepareClaim(current.phase === "plan" ? {
    ...current,
    ...dismissal,
    checkpointCommit: commitRemaps?.get(current.checkpointCommit) ?? current.checkpointCommit,
    retainedArc: nextLifecycle,
    stackTip,
  } : {
    ...current,
    ...nextLifecycle,
    ...dismissal,
    retainedArc: null,
    stackTip,
  }, {
    commitRemaps,
    expectedCheckpointCommit: commitRemaps?.get(current.checkpointCommit) ?? current.checkpointCommit,
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
    // The diff queue owns this build and may start it after the requesting operation's read scope closed.
    build: async signal => await GitObjectReadSession.detached(async () => await repository.buildFileChanges(baseCommit, targetTree, paths, signal)),
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
    /** Already known amendability, e.g. of a commit this acceptance just created; skips classification. */
    amendability?: WorkbenchGitCommitAmendability;
    includeNewerAvailable?: boolean;
    preparedHead?: WorkbenchGitPreparedHead;
    refreshAmendability?: boolean;
    sealedInLayer?: string | null;
    waitingForLayer?: string | null;
  } = {},
): Promise<GitCheckpointProposal> {
  const targetTree = "tree" in target ? target.tree : await repository.resolveTree(target.commit);
  const classifiedAmendability = metadata.status !== "committed" || !metadata.committedSha
    ? null
    : options.amendability ?? await new WorkbenchGitHistoryRewriter(repository).classifyAmendability(
      metadata.committedSha,
      { preparedHead: options.preparedHead, refresh: options.refreshAmendability ?? true },
    );
  const amendability: GitCheckpointProposal["amendability"] = classifiedAmendability?.status === "available"
    ? { status: "available" }
    : classifiedAmendability;
  const freshCommitMessage = metadata.mode === "amend" && metadata.status === "proposed"
    ? metadata.freshCommitMessage ?? null
    : null;
  const [changes, freshChanges, amendTargetMessage] = await Promise.all([
    buildProposalFileChanges(proposalDiffs, repository, metadata, targetTree),
    freshCommitMessage
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
    freshCommitMessage,
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
  const state = await new GitCheckpointStore(repository).createProposalCommit(tree, metadata, { previous: proposal });
  await repository.updateRefs([{ newValue: state.commit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef }]);
  return { ...proposal, metadata: state.metadata, proposalCommit: state.commit, tree };
}

async function resolveProposalState(
  resolveThreadIdentity: GitArcThreadIdentityResolver,
  repository: WorkbenchGitRepository,
  harness: GitArcHarness,
  threadId: string,
  proposalId: string,
  options: {
    /** Proposals an acceptance already landed in memory; stack decisions treat them as committed. */
    acceptedInBatch?: ReadonlySet<string>;
    includeNewer: boolean;
    persistTransitions: boolean;
    /** Sealed proposals never offer newer work: it belongs to higher stack layers. */
    sealed?: boolean;
    snapshot?: { head: string | null; tree: string };
  },
): Promise<{
  currentTree: string | null;
  includeNewerAvailable: boolean;
  proposal: StoredProposal;
  /** Unpersisted transitions were derived; the caller persists or publishes them. */
  transitioned: boolean;
  waitingForLayer: string | null;
}> {
  const store = new GitCheckpointStore(repository, resolveThreadIdentity);
  let proposal = await store.readProposal(harness, threadId, proposalId);
  let transitioned = false;
  const applyTransition = async (metadata: ProposalMetadata, treeish?: string) => {
    if (options.persistTransitions) return await persistProposalTransition(repository, proposal, metadata, treeish);
    transitioned = true;
    return deriveProposalTransition(proposal, metadata, treeish);
  };
  // Layers sealed before stacking made amendments fresh still hold them as amends.
  if (
    options.sealed
    && proposal.metadata.status === "proposed"
    && proposal.metadata.mode === "amend"
    && proposal.metadata.freshCommitMessage
    && !proposal.metadata.messageOnly
  ) {
    const fresh = await freshCommitProposal(repository, proposal);
    proposal = await applyTransition(fresh.metadata, fresh.tree);
  }
  if (proposal.metadata.stackBase && proposal.metadata.status === "proposed") {
    const head = options.snapshot ? options.snapshot.head : await repository.headOrNull();
    const stacked = await new GitArcStackController(repository, resolveThreadIdentity).classifyStackedProposal(
      proposal.metadata.stackBase, proposal.metadata.livePaths, head,
      derivedStatusResolver(resolveThreadIdentity, repository, options.snapshot, options.acceptedInBatch),
    );
    if (stacked.kind === "waiting") {
      return { currentTree: null, includeNewerAvailable: false, proposal, transitioned, waitingForLayer: stacked.layerTitle };
    }
    if (stacked.kind === "broken") {
      proposal = await applyTransition({
        ...proposal.metadata, status: "unavailable", unavailableReason: STACK_BROKEN_UNAVAILABLE_REASON, unavailableReasonCode: null,
      });
      return { currentTree: null, includeNewerAvailable: false, proposal, transitioned, waitingForLayer: null };
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
    return { currentTree, includeNewerAvailable, proposal, transitioned, waitingForLayer: null };
  }
  return { currentTree, includeNewerAvailable: false, proposal, transitioned, waitingForLayer: null };
}

/** Stack decisions read derived proposal status without persisting transitions. */
function derivedStatusResolver(
  resolveThreadIdentity: GitArcThreadIdentityResolver,
  repository: WorkbenchGitRepository,
  snapshot?: { head: string | null; tree: string },
  acceptedInBatch?: ReadonlySet<string>,
): GitArcStackStatusResolver {
  return async (owner, proposalId) => acceptedInBatch?.has(proposalId) ? "committed" : (await resolveProposalState(
    resolveThreadIdentity, repository, normalizeHarness(owner.harness), owner.threadId, proposalId,
    { acceptedInBatch, includeNewer: false, persistTransitions: false, snapshot },
  )).proposal.metadata.status;
}

export default class GitArcProposalController {
  constructor(
    private readonly proposalDiffs = new GitArcProposalDiffController(),
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
    private readonly readDurableProposalIds: GitArcDurableProposalReader = async () => new Map(),
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
    const proposedPaths: string[] = [];
    const visibility = entry ? acceptedVisibility(entry) : { dismissed: [], viewed: [] };
    const hiddenAccepted = new Set([...visibility.dismissed, ...visibility.viewed]);
    // Viewed and dismissed ids are accepted proposals status never shows again, so they need no read at all.
    const shownIds = proposalIds.filter(proposalId => !hiddenAccepted.has(proposalId));
    // Committed metadata is final, so one batched read settles those rows without per-proposal resolution.
    const summaries = new Map((await this.store(repository).readProposalSummaries(harness, input.threadId, shownIds))
      .map(summary => [summary.proposalId, summary]));
    for (const proposalId of shownIds) {
      const summary = summaries.get(proposalId);
      if (summary?.status === "committed") {
        if (summary.committedSha) {
          accepted.push({ proposalId, title: summary.title, commitSha: summary.committedSha });
        }
        continue;
      }
      const { proposal } = await resolveProposalState(this.resolveThreadIdentity, repository, harness, input.threadId, proposalId, {
        includeNewer: false, persistTransitions: false, snapshot,
      });
      const metadata = proposal.metadata;
      const layer = layers.find(({ layer: candidate }) => candidate.proposalIds.includes(proposalId));
      if (metadata.status === "proposed") {
        if (layer) stackedPending.set(layer.tipCommit, [...stackedPending.get(layer.tipCommit) ?? [], { proposalId, title: metadata.title }]);
        else {
          pending.push({ proposalId, title: metadata.title });
          const edited = new Set(await repository.listChangedPaths(proposal.tree, snapshot.tree, metadata.livePaths));
          proposedPaths.push(...metadata.livePaths.filter(livePath => !edited.has(livePath)));
        }
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
    return {
      proposedPaths,
      status: { pending, accepted, ...(stacked.length ? { stacked } : {}), ...(unavailable.length ? { unavailable } : {}) },
    };
  }

  /** The given accepted proposal ids this thread's lifecycle owns that status has not yet shown it. */
  async readUnviewedAccepted(input: ArcIdentityInput & { proposalIds: string[]; repository?: WorkbenchGitRepository }) {
    const repository = input.repository ?? await WorkbenchGitRepository.open(input.cwd);
    const entry = await this.registry(repository).find({ harness: normalizeHarness(input.harness), threadId: input.threadId });
    if (!entry) return [];
    const owned = new Set(lifecycleEntry(entry)?.proposalIds ?? []);
    const { viewed } = acceptedVisibility(entry);
    const viewedIds = new Set(viewed);
    return input.proposalIds.filter(id => owned.has(id) && !viewedIds.has(id));
  }

  /** Record that status showed these accepted proposals to their owner. */
  async markAcceptedViewed(input: ArcIdentityInput & { proposalIds: string[]; repository?: WorkbenchGitRepository }) {
    const repository = input.repository ?? await WorkbenchGitRepository.open(input.cwd);
    const registry = this.registry(repository);
    const entry = await registry.find({ harness: normalizeHarness(input.harness), threadId: input.threadId });
    if (!entry) return;
    const owned = new Set(lifecycleEntry(entry)?.proposalIds ?? []);
    const visibility = acceptedVisibility(entry);
    const viewedIds = new Set(visibility.viewed);
    const added = input.proposalIds.filter(id => owned.has(id) && !viewedIds.has(id));
    if (!added.length) return;
    const mutation = await registry.prepareSet({
      ...entry, acceptedVisibility: { dismissed: visibility.dismissed, viewed: [...visibility.viewed, ...added] },
    }, entry.checkpointCommit);
    await repository.updateRefs(mutation.updates);
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
    const stackLayers = await Promise.all(projected.map(async ({ entry }) => await stack.projectLayers(entry)));
    const store = this.store(repository);
    const durable = await this.readDurableProposalIds([...new Set(projected.map(({ entry }) => entry.threadId))]);
    const summaries = await store.readProposalSummaryGroups(
      projected.map(({ entry, lifecycle }, index) => ({
        harness: normalizeHarness(entry.harness),
        proposalIds: projectedProposalIds(lifecycle!, stackLayers[index] ?? [], durable.get(entry.threadId)),
        threadId: entry.threadId,
      })),
    );
    const committed = await Promise.all(projected.map(async ({ entry }) => (
      await store.readCommittedProposalHistory(normalizeHarness(entry.harness), entry.threadId, durable.get(entry.threadId))
    )));
    return projected.map(({ entry, lifecycle, saved }, index) => (
      projectLifecycleState(
        entry,
        lifecycle!,
        lifecycleSummaries(committed[index] ?? [], summaries[index] ?? []),
        saved,
        stackLayers[index] ?? [],
      )
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
    const stackLayers = await this.stack(repository).projectLayers(entry);
    const store = this.store(repository);
    const durable = (await this.readDurableProposalIds([entry.threadId])).get(entry.threadId);
    const summaries = await store.readProposalSummaries(
      harness,
      input.threadId,
      projectedProposalIds(lifecycle, stackLayers, durable),
    );
    const committed = await store.readCommittedProposalHistory(harness, input.threadId, durable);
    return projectLifecycleState(entry, lifecycle, lifecycleSummaries(committed, summaries), saved, stackLayers);
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

  /** The treeish current arc work is measured from: HEAD with baseline stack tip sealed paths, else accepted or checkpoint history. */
  async logicalBaseline(input: ArcIdentityInput & {
    checkpointCommit: string;
    checkpointParent: string | null;
    /** The owner's registry entry when the caller already holds it. */
    entry?: Pick<GitArcRegistryEntry, "stackTip"> | null;
    /** Measure from real history even while stack layers are pending. */
    ignoreStack?: boolean;
    repository?: WorkbenchGitRepository;
  }) {
    const repository = input.repository ?? await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    if (!input.ignoreStack) {
      const entry = input.entry !== undefined ? input.entry : await this.registry(repository).find({ harness, threadId: input.threadId });
      const stack = this.stack(repository);
      const tip = await stack.baselineTip(entry, { parent: input.checkpointParent });
      // Unsealed paths in a tip are stale HEAD content; measure them from HEAD instead.
      if (tip) return await stack.sealedTree(await repository.headOrNull(), tip.commit);
    }
    const outcome = await this.store(repository).readOutcome(harness, input.threadId, input.checkpointCommit);
    return outcome?.acceptedProposals?.at(-1)?.headSha ?? input.checkpointParent;
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
    if (target.metadata.status === "proposed") {
      return await this.publishPendingRevision({
        description,
        harness,
        repository,
        target,
        threadId,
        title,
        tree: target.tree,
      });
    }
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
    const { commit: proposalCommit } = await store.createProposalCommit(proposalTree, metadata);
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
      { newValue: proposalCommit, oldValue: null, ref: await store.proposalRefName(harness, threadId, proposalId) },
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

  private async publishPendingRevision({
    description,
    harness,
    livePaths,
    paths,
    repository,
    target,
    threadId,
    title,
    tree,
  }: {
    description: string;
    harness: GitArcHarness;
    livePaths?: string[];
    paths?: string[];
    repository: WorkbenchGitRepository;
    target: StoredProposal;
    threadId: string;
    title: string;
    tree: string;
  }): Promise<GitCheckpointProposalReceipt> {
    const registry = this.registry(repository);
    const current = await registry.find({ harness, threadId });
    if (!current) throw new GitArcRejectionError({ reason: "proposalNotOwned" });
    const stack = this.stack(repository);
    const sealingLayer = await stack.sealingLayer(current, target.metadata.proposalId);
    const proposalTitle = title.trim() || target.metadata.title;
    const proposalDescription = title.trim() ? description.trim() : target.metadata.description;
    commitMessage(proposalTitle, proposalDescription);
    if (
      tree === target.tree
      && proposalTitle === target.metadata.title
      && proposalDescription === target.metadata.description
    ) {
      throw new GitArcRejectionError({ reason: "unchangedMessage" });
    }
    const proposalId = randomUUID();
    const metadata: ProposalMetadata = {
      ...target.metadata,
      committedSha: null,
      description: proposalDescription,
      livePaths: livePaths ?? target.metadata.livePaths,
      paths: paths ?? target.metadata.paths,
      proposalId,
      sourceCheckpoint: sealingLayer
        ? target.metadata.sourceCheckpoint
        : lifecycleEntry(current)?.checkpointCommit ?? target.metadata.sourceCheckpoint,
      status: "proposed",
      supersededByProposalId: null,
      supersededBySha: null,
      title: proposalTitle,
      unavailableReason: null,
    };
    const created = await this.store(repository).createProposalCommit(tree, metadata);
    const proposalCommit = created.commit;
    const replacement: StoredProposal = {
      metadata: created.metadata,
      proposalCommit,
      proposalRef: await this.store(repository).proposalRefName(harness, threadId, proposalId),
      tree,
    };
    const stackRevision = await stack.prepareProposalRevision(current, target.metadata.proposalId, replacement);
    const excludedRefs = [
      REGISTRY_REF,
      target.proposalRef,
      ...(stackRevision?.replacedRefs ?? []),
    ];
    const rewrite = await new GitArcHistoryRewriter(repository).prepare(
      stackRevision?.commits ?? new Map(),
      { excludeRefs: excludedRefs },
    );
    const nextEntry = revisedRegistryEntry(current, target.metadata.proposalId, proposalId, rewrite.commits);
    const registryMutation = await registry.prepareClaim(nextEntry, {
      commitRemaps: rewrite.commits,
      expectedCheckpointCommit: current.checkpointCommit,
    });
    const supersededMetadata: ProposalMetadata = {
      ...remapProposalMetadata(target.metadata, rewrite.commits),
      status: "superseded",
      supersededByProposalId: proposalId,
      supersededBySha: null,
      unavailableReason: null,
    };
    const { commit: supersededCommit } = await this.store(repository).createProposalCommit(target.tree, supersededMetadata, { previous: target });
    await repository.updateRefs([
      ...(stackRevision?.updates ?? []),
      ...rewrite.updates,
      ...registryMutation.updates,
      { newValue: supersededCommit, oldValue: target.proposalCommit, ref: target.proposalRef },
      { newValue: proposalCommit, oldValue: null, ref: replacement.proposalRef },
    ], [...(stackRevision?.deletes ?? []), ...rewrite.deletes]);
    return {
      baseCommit: metadata.baseCommit,
      description: metadata.description,
      intentName: current.intentName,
      paths: metadata.paths,
      proposalId,
      scopePaths: current.phase === "plan" ? current.retainedArc?.claimedPaths ?? [] : current.claimedPaths,
      sourceCheckpoint: metadata.sourceCheckpoint,
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
    threadId,
    title,
  }: ArcIdentityInput & {
    amend?: boolean;
    amendProposalId?: string;
    description: string;
    freshDescription?: string;
    freshTitle?: string;
    paths?: string[];
    title: string;
  }): Promise<GitCheckpointProposalReceipt> {
    if (amend && !amendProposalId) throw new GitArcRejectionError({ reason: "missingAmendTarget" });
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
    let proposable = await this.requireProposableArc({ cwd, harness: rawHarness, threadId });
    // New work builds on a pending stack, so the stack first follows HEAD past commits that left its sealed paths alone.
    if (await this.stack(proposable.repository).rebaseOntoHead(proposable.active, await proposable.repository.headOrNull())) {
      proposable = await this.requireProposableArc({ cwd, harness: rawHarness, threadId });
    }
    const { active, arc, checkpoint, claimedPaths, harness, metadata: checkpointMetadata, proposalIds, registry, repository } = proposable;
    const store = this.store(repository);
    const stack = this.stack(repository);
    const [baselineTip, sealedIds] = await Promise.all([stack.baselineTip(active, checkpoint), stack.sealedProposalIds(active)]);
    const stackTip = baselineTip?.pending ? baselineTip.commit : null;
    let replacementTarget: StoredProposal | null = null;
    let amendTargetProposal: StoredProposal | null = null;
    // A rescinded proposal comes back as a new proposal over current work, keeping its message, paths and mode.
    let revivalTarget: StoredProposal | null = null;
    if (amendProposalId) {
      const target = await store.readProposal(harness, threadId, amendProposalId);
      if (target.metadata.status === "proposed") {
        replacementTarget = target;
        amend = false;
      } else if (target.metadata.status === "rescinded") {
        revivalTarget = target;
        amend = false;
        if (target.metadata.mode === "amend") {
          freshTitle ??= target.metadata.freshCommitMessage?.title;
          freshDescription ??= target.metadata.freshCommitMessage?.description;
        }
      } else {
        amendTargetProposal = target;
        if (target.metadata.status !== "committed" || !target.metadata.committedSha) {
          throw new GitArcRejectionError({ reason: "proposalRequiresCommittedTarget" }, "A targeted amend requires a pending, rescinded or committed proposal.");
        }
        if (!freshTitle?.trim()) throw new GitArcRejectionError({ reason: "missingFreshTitle" });
        amend = true;
      }
    }
    if (replacementTarget && (freshTitle !== undefined || freshDescription !== undefined)) {
      throw new GitArcRejectionError({ reason: "unexpectedFreshMetadata" });
    }
    if (amend && !freshTitle?.trim()) throw new GitArcRejectionError({ reason: "missingFreshTitle" });
    const revivalAmendSha = revivalTarget?.metadata.mode === "amend" ? revivalTarget.metadata.amendTargetSha : null;
    if (stackTip && (amend || revivalAmendSha)) throw new GitArcRejectionError({ reason: "amendOnPendingStack" });
    let requestedPaths = repository.normalizePaths(rawPaths?.length ? rawPaths : claimedPaths);
    if (rawPaths?.length) {
      const claimed = new GitArcPathSet(claimedPaths);
      const outsideClaim = requestedPaths.filter((candidate) => !claimed.overlaps(candidate));
      if (outsideClaim.length) throw new GitArcRejectionError({ reason: "pathsOutsideClaims", paths: outsideClaim }, `Proposed paths must stay within the arc's claimed set: ${outsideClaim.join(", ")}`);
      // A folder holding claims selects only those claims, never unclaimed content beneath it.
      requestedPaths = [...new Set(requestedPaths.flatMap((candidate) => claimed.covers(candidate) ? [candidate] : claimed.overlapping(candidate)))];
    }
    let liveBaseCommit: string | null;
    if (stackTip) {
      // Stacked proposals build on sealed layers, which real HEAD only gains as the user commits them.
      await stack.validateBaseline(stackTip, requestedPaths, await repository.headOrNull());
      liveBaseCommit = stackTip;
    } else if (baselineTip) {
      // A landed stack is real history now: measure from its tip and build on HEAD, which already holds it.
      await stack.validateBaseline(baselineTip.commit, requestedPaths, await repository.headOrNull());
      liveBaseCommit = await repository.headOrNull();
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
    const requestedAmendTarget = amendTargetProposal?.metadata.committedSha ?? revivalAmendSha;
    let amendTargetSha: string | null = null;
    if (requestedAmendTarget) {
      const publishState = await new GitArcPublishState(repository).classifyCommit(requestedAmendTarget);
      if (publishState.kind === "pushed" && freshTitle?.trim()) {
        // Pushed targets cannot be amended; keep only the fresh-commit choice so agents never need to pre-check.
        title = freshTitle;
        description = freshDescription ?? "";
      } else {
        GitArcPublishState.requireUnpushed(publishState);
        amendTargetSha = requestedAmendTarget;
      }
    }
    const baseCommit = amendTargetSha ? await repository.resolveParent(amendTargetSha) : liveBaseCommit;
    let representedTree: string | null = null;
    let editedTree: string | null = null;
    let unproposedPaths: string[] | null = null;
    if (amendProposalId && !rawPaths?.length) {
      representedTree = await repository.resolveTree(liveBaseCommit);
      const pendingProposals = (await store.listProposals(harness, threadId))
        .filter(proposal => proposal.metadata.status === "proposed" && !sealedIds.has(proposal.metadata.proposalId));
      for (const proposal of pendingProposals) {
        representedTree = await repository.writeTreeWithPathsFromSource(
          representedTree,
          proposal.tree,
          proposal.metadata.livePaths,
        );
      }
      editedTree = await repository.writeScopedWorktreeTree(requestedPaths, representedTree);
      unproposedPaths = await repository.listChangedPaths(representedTree, editedTree, requestedPaths);
    }
    let proposalTree: string;
    if (replacementTarget) {
      if (!representedTree || !editedTree || !unproposedPaths) {
        representedTree = await repository.resolveTree(liveBaseCommit);
        for (const proposalId of proposalIds.filter(id => !sealedIds.has(id))) {
          const proposal = await store.readProposal(harness, threadId, proposalId);
          if (proposal.metadata.status !== "proposed") continue;
          representedTree = await repository.writeTreeWithPathsFromSource(
            representedTree,
            proposal.tree,
            proposal.metadata.livePaths,
          );
        }
        editedTree = await repository.writeScopedWorktreeTree(requestedPaths, representedTree);
        unproposedPaths = await repository.listChangedPaths(representedTree, editedTree, requestedPaths);
      }
      if (unproposedPaths.length) {
        try {
          proposalTree = await repository.mergeTree(representedTree, replacementTarget.tree, editedTree);
        } catch (error) {
          throw new GitArcRejectionError({ reason: "proposalRevisionConflict" }, error instanceof Error ? error.message : String(error));
        }
      } else {
        proposalTree = replacementTarget.tree;
      }
      const paths = [...new Set([...replacementTarget.metadata.paths, ...unproposedPaths])].sort();
      return await this.publishPendingRevision({
        description,
        harness,
        livePaths: paths,
        paths,
        repository,
        target: replacementTarget,
        threadId,
        title,
        tree: proposalTree,
      });
    }
    const selectedPaths = unproposedPaths ?? requestedPaths;
    proposalTree = await repository.writeScopedWorktreeTree(selectedPaths, amendTargetSha ?? liveBaseCommit);
    const livePaths = await repository.listChangedPaths(liveBaseCommit, proposalTree, selectedPaths);
    if (!livePaths.length) throw new GitArcRejectionError({ reason: "noChangesToPropose" }, "The selected arc paths do not contain any working-tree changes to propose.");
    // Sealed proposals may overlap: later layers deliberately build on their files.
    await this.requireNoPendingOverlap(repository, harness, threadId, proposalIds.filter(id => !sealedIds.has(id)), livePaths);
    const paths = amendTargetSha
      ? await repository.listAllChangedPaths(baseCommit, proposalTree)
      : livePaths;
    const inheritedMessage = revivalTarget
      ? { description: revivalTarget.metadata.description, title: revivalTarget.metadata.title }
      : amendTargetSha ? parseCommitMessage(await repository.readCommitMessage(amendTargetSha)) : null;
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
      proposedAt: formatGitRawDate(new Date()),
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
    const { commit: proposalCommit } = await store.createProposalCommit(proposalTree, metadata);
    await buildProposalFileChanges(this.proposalDiffs, repository, metadata, proposalTree);
    // New proposals append so every still-pending proposal remains visible to the thread; a revival retires its original.
    const nextProposalIds = [...proposalIds.filter(id => id !== revivalTarget?.metadata.proposalId), proposalId];
    const retiredRevivalTarget = revivalTarget ? {
      newValue: (await store.createProposalCommit(revivalTarget.tree, {
        ...revivalTarget.metadata, status: "superseded", supersededByProposalId: proposalId, supersededBySha: null,
      }, { previous: revivalTarget })).commit,
      oldValue: revivalTarget.proposalCommit,
      ref: revivalTarget.proposalRef,
    } : null;
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
    await repository.updateRefs([
      { newValue: proposalCommit, oldValue: null, ref: await store.proposalRefName(harness, threadId, proposalId) },
      ...registryMutation.updates,
      ...retiredRevivalTarget ? [retiredRevivalTarget] : [],
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
    // Each pending proposal checks its own paths against one index; the full overlap list is built only to reject.
    const requested = new GitArcPathSet(livePaths);
    for (const proposalId of proposalIds) {
      const { proposal } = await resolveProposalState(this.resolveThreadIdentity, repository, harness, threadId, proposalId, {
        includeNewer: false, persistTransitions: false,
      });
      if (proposal.metadata.status !== "proposed") continue;
      if (!proposal.metadata.livePaths.some(pendingPath => requested.overlaps(pendingPath))) continue;
      const pending = new GitArcPathSet(proposal.metadata.livePaths);
      const overlapping = livePaths.filter(candidate => pending.overlaps(candidate));
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
    const excluded = new GitArcPathSet([...excludedPaths, ...entries.flatMap(getGitArcLiveClaimPaths)]);
    return changedPaths.filter(candidate => !excluded.overlaps(candidate));
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
    const { commit: stateCommit } = await this.store(repository).createProposalCommit(proposal.tree, metadata, { previous: proposal });
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
          const state = await store.createProposalCommit(targetTree, {
            ...remapProposalMetadata(proposal.metadata, arcPlan.commits),
            amendTargetSha: nextCommit,
            committedSha: nextCommit,
            description: description.trim(),
            liveBaseCommit: newHead,
            // In-place amends of a committed proposal keep the pointer to the row it superseded.
            ...(proposal.metadata.status === "proposed" ? { replacedSha: target } : {}),
            sourceCheckpoint,
            status: "committed",
            title: title.trim(),
            unavailableReason: null,
          }, { previous: proposal });
          committedMetadata = state.metadata;
          const updates: GitRefUpdate[] = [{ newValue: state.commit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef }];
          const replaceRefs = [proposal.proposalRef, oldOutcomeRef];
          if (supersededPrior) {
            const priorMetadata: ProposalMetadata = {
              ...remapProposalMetadata(supersededPrior.metadata, arcPlan.commits),
              committedSha: nextCommit,
              status: "superseded",
              supersededByProposalId: proposal.metadata.proposalId,
              supersededBySha: nextCommit,
            };
            const { commit: priorState } = await store.createProposalCommit(supersededPrior.tree, priorMetadata, { previous: supersededPrior });
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
            oldValue: nextOutcomeRef === oldOutcomeRef ? oldOutcomeValue : null,
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

  async commitProposal({ cwd, harness, threadId, ...entry }: ArcIdentityInput & GitArcProposalCommitEntry): Promise<GitCheckpointProposal> {
    const { failed, landed } = await this.commitProposals({ cwd, entries: [entry], harness, threadId });
    if (failed) throw failed.error;
    return landed[0]!;
  }

  /**
   * Commits proposals in order inside one operation and stops at the first failure so earlier ones stay landed. Runs of
   * fresh commits land in memory and publish as one ref transaction with one claim transition; history amends and
   * message-only acceptances publish alone. One worktree capture serves the whole batch: edits made while it runs count as after it.
   */
  async commitProposals({ cwd, entries, harness: rawHarness, onAdvance, threadId, worktree: captured }: ArcIdentityInput & {
    entries: GitArcProposalCommitEntry[];
    /**
     * Called synchronously once the acceptance moves past a proposal: its commit is built for the shared publish, or it
     * landed alone. Runs inside the landing, so it must never wait on Git or repository gates.
     */
    onAdvance?: (proposalId: string) => void;
    /** A capture shared with earlier parts of the same acceptance; captured here when absent. */
    worktree?: GitWorktreeSnapshot;
  }) {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    const worktree = captured ?? await this.captureAcceptanceWorktree({ cwd, entries, harness, threadId });
    const landed: GitCheckpointProposal[] = [];
    let batch: CommitBatch | null = null;
    const flush = async () => {
      const pending: CommitBatch | null = batch;
      batch = null;
      if (!pending?.landings.length) return null;
      try {
        landed.push(...await this.publishCommitBatch(repository, harness, threadId, pending));
        return null;
      } catch (error) {
        return { failed: { error, proposalId: pending.landings[0]!.proposal.metadata.proposalId }, landed };
      }
    };
    for (const entry of entries) {
      try {
        if (await this.landsInBatch(repository, harness, threadId, entry)) {
          batch ??= await this.openCommitBatch(repository, harness, threadId, worktree);
          await this.prepareCommitLanding(repository, harness, threadId, entry, batch);
          onAdvance?.(entry.proposalId);
          continue;
        }
      } catch (error) {
        const stopped = await flush();
        if (stopped) return stopped;
        if (error instanceof UnavailableLandingError) {
          try {
            await persistProposalTransition(repository, error.proposal, error.proposal.metadata, error.proposal.tree);
          } catch (persistError) {
            return { failed: { error: persistError, proposalId: entry.proposalId }, landed };
          }
        }
        return { failed: { error, proposalId: entry.proposalId }, landed };
      }
      const stopped = await flush();
      if (stopped) return stopped;
      try {
        landed.push(await this.acceptProposal(repository, harness, threadId, entry, worktree));
      } catch (error) {
        return { failed: { error, proposalId: entry.proposalId }, landed };
      }
      onAdvance?.(entry.proposalId);
    }
    return await flush() ?? { failed: null, landed };
  }

  /** Worktree content for every claimed and proposed path, or the whole worktree when unclaimed files are being folded in. */
  async captureAcceptanceWorktree({ cwd, entries, harness: rawHarness, threadId }: ArcIdentityInput & { entries: GitArcProposalCommitEntry[] }): Promise<GitWorktreeSnapshot> {
    const repository = await WorkbenchGitRepository.open(cwd);
    const harness = normalizeHarness(rawHarness);
    if (entries.some(({ unclaimedSelection }) => unclaimedSelection)) return await repository.writeWorktreeSnapshot();
    const store = this.store(repository);
    const active = await this.registry(repository).find({ harness, threadId });
    const proposalPaths = await Promise.all(entries.map(async ({ proposalId }) => {
      try {
        return (await store.readProposal(harness, threadId, proposalId)).metadata.livePaths;
      } catch (error) {
        // Its acceptance reports the missing proposal itself.
        if (error instanceof GitArcRejectionError && error.rejection.reason === "proposalNotFound") return [];
        throw error;
      }
    }));
    const paths = [...new Set([...(active ? lifecycleEntry(active)?.claimedPaths ?? [] : []), ...proposalPaths.flat()])];
    const head = await repository.headOrNull();
    return { head, tree: paths.length ? await repository.writeScopedWorktreeTree(paths, head) : await repository.resolveTree(head) };
  }

  /**
   * A proposal's acceptable state on `snapshot.head`, with any unclaimed selection folded in. `acceptedInBatch` names
   * proposals this acceptance already landed in memory. A newly unavailable state is returned unpersisted, for the
   * caller to store before rejecting; rebases onto landed history publish with the commit itself.
   */
  private async resolveAcceptance(
    repository: WorkbenchGitRepository,
    harness: GitArcHarness,
    threadId: string,
    { includeNewer: requestedIncludeNewer, proposalId, unclaimedSelection }: GitArcProposalCommitEntry,
    snapshot: { head: string | null; tree: string },
    acceptedInBatch?: ReadonlySet<string>,
  ) {
    // Newer work above a sealed proposal belongs to higher layers, so sealed commits never include it.
    const sealed = Boolean(await this.sealingLayer(repository, harness, threadId, proposalId));
    const includeNewer = requestedIncludeNewer && !sealed;
    const resolved = await resolveProposalState(
      this.resolveThreadIdentity,
      repository,
      harness,
      threadId,
      proposalId,
      { acceptedInBatch, includeNewer, persistTransitions: false, sealed, snapshot },
    );
    if (resolved.transitioned && resolved.proposal.metadata.status !== "proposed") {
      return { includeNewer, resolved, unavailable: resolved.proposal };
    }
    if (resolved.waitingForLayer) {
      throw new GitArcRejectionError({ reason: "proposalUnavailable" }, `Commit the lower stack layer "${resolved.waitingForLayer}" first.`);
    }
    if (unclaimedSelection) {
      const proposal = resolved.proposal;
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
      resolved.proposal = {
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
    return { includeNewer, resolved, unavailable: null };
  }

  /** Whether an entry lands as a fresh commit, which batches; history amends and message-only acceptances land alone. */
  private async landsInBatch(repository: WorkbenchGitRepository, harness: GitArcHarness, threadId: string, { mode, proposalId }: GitArcProposalCommitEntry) {
    const { metadata } = await this.store(repository).readProposal(harness, threadId, proposalId);
    if (metadata.status === "committed" || metadata.messageOnly) return false;
    // Layers sealed before stacking made amends fresh still hold the amend; resolution lands them fresh.
    const sealedFresh = metadata.mode === "amend" && Boolean(metadata.freshCommitMessage)
      && Boolean(await this.sealingLayer(repository, harness, threadId, proposalId));
    return (mode ?? (sealedFresh ? "commit" : metadata.mode)) === "commit";
  }

  /** Land one proposal that amends history or only its message; fresh commits land through commit batches. */
  private async acceptProposal(
    repository: WorkbenchGitRepository,
    harness: GitArcHarness,
    threadId: string,
    entry: GitArcProposalCommitEntry,
    worktree: GitWorktreeSnapshot,
  ): Promise<GitCheckpointProposal> {
    const { description, mode, proposalId, title } = entry;
    // HEAD moves as earlier entries land; the captured worktree content stays.
    const snapshot = { head: await repository.headOrNull(), tree: worktree.tree };
    const { includeNewer, resolved, unavailable } = await this.resolveAcceptance(repository, harness, threadId, entry, snapshot);
    if (unavailable) resolved.proposal = await persistProposalTransition(repository, unavailable, unavailable.metadata, unavailable.tree);
    const proposal = resolved.proposal;
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
    const stack = this.stack(repository);
    const sourceIsOwned = await store.lineageContains(harness, threadId, activeSource, proposalSource.checkpointCommit)
      || Boolean(await stack.sealingLayer(active, proposalId));
    if (!sourceIsOwned) {
      throw new GitArcRejectionError({ reason: "proposalNotOwned" }, "The proposal no longer belongs to this thread's active Git arc.");
    }
    const previousAcceptedProposals = await store.readAcceptedOutcomes(harness, threadId, activeSource);
    if (selectedMode === "amend") {
      const amendTargetSha = proposal.metadata.amendTargetSha;
      if (!amendTargetSha) throw new Error("This amend proposal has no target commit.");
      const message = commitMessage(title, description);
      const targetTree = includeNewer && resolved.includeNewerAvailable ? resolved.currentTree! : proposal.tree;
      const oldOutcomeRef = outcomeRef(harness, threadId, activeSource.checkpointCommit);
      const supersededProposalId = previousAcceptedProposals.slice().reverse().find((receipt) => (
        receipt.commitSha === amendTargetSha && receipt.proposalId !== proposalId
      ))?.proposalId ?? null;
      const supersededPrior = supersededProposalId
        ? await store.readProposal(harness, threadId, supersededProposalId)
        : await store.findCommittedProposalBySha(harness, threadId, amendTargetSha, proposalId);
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
          target: amendTargetSha,
          targetTree,
          mutatePlan: async ({ amendedCommit, arcPlan, headRef, newHead }) => {
          const remappedSource = arcPlan.commits.get(activeSource.checkpointCommit) ?? activeSource.checkpointCommit;
          const state = await store.createProposalCommit(targetTree, {
            ...remapProposalMetadata(proposal.metadata, arcPlan.commits),
            amendTargetSha: amendedCommit,
            committedSha: amendedCommit,
            description: description.trim(),
            liveBaseCommit: newHead,
            ...(proposal.metadata.amendTargetSha ? { replacedSha: proposal.metadata.amendTargetSha } : {}),
            sourceCheckpoint: remappedSource,
            status: "committed",
            title: title.trim(),
            unavailableReason: null,
          }, { previous: proposal });
          committedMetadata = state.metadata;
          const updates: GitRefUpdate[] = [{ newValue: state.commit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef }];
          const replaceRefs = [proposal.proposalRef, REGISTRY_REF];
          if (supersededPrior) {
            const priorMetadata: ProposalMetadata = {
              ...remapProposalMetadata(supersededPrior.metadata, arcPlan.commits),
              committedSha: amendedCommit,
              status: "superseded",
              supersededByProposalId: proposalId,
              supersededBySha: amendedCommit,
            };
            const { commit: priorState } = await store.createProposalCommit(supersededPrior.tree, priorMetadata, { previous: supersededPrior });
            updates.push({ newValue: priorState, oldValue: supersededPrior.proposalCommit, ref: supersededPrior.proposalRef });
            replaceRefs.push(supersededPrior.proposalRef);
          }
          const transition = await prepareAcceptedClaimTransition({
            acceptedHead: newHead,
            commitRemaps: arcPlan.commits,
            harness,
            proposalIds: [proposalId],
            registry,
            resolveThreadIdentity: this.resolveThreadIdentity,
            repository,
            source: activeSource,
            stack,
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
            oldValue: oldOutcomeRef === nextOutcomeRef ? oldOutcome : null,
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
    throw new Error("Fresh-commit acceptances land through commit batches.");
  }

  /** The arc facts every landing in a batch shares; nothing publishes until the batch does, so they stay current. */
  private async openCommitBatch(repository: WorkbenchGitRepository, harness: GitArcHarness, threadId: string, worktree: GitWorktreeSnapshot): Promise<CommitBatch> {
    const store = this.store(repository);
    const active = await this.registry(repository).find({ harness, threadId });
    const lifecycle = active ? lifecycleEntry(active) : null;
    if (!active || !lifecycle) {
      throw new GitArcRejectionError({ reason: "proposalNotOwned" }, "The proposal no longer belongs to this thread's Git arc.");
    }
    const activeSource = await store.readCheckpoint(harness, threadId, lifecycle.checkpointCommit);
    const head = await repository.headOrNull();
    return {
      accepted: [...await store.readAcceptedOutcomes(harness, threadId, activeSource)],
      acceptedIds: new Set(),
      active,
      activeSource,
      head,
      landings: [],
      startHead: head,
      worktree,
    };
  }

  /** Commit one fresh-commit proposal onto the batch head in memory; earlier landings count as committed. */
  private async prepareCommitLanding(
    repository: WorkbenchGitRepository,
    harness: GitArcHarness,
    threadId: string,
    entry: GitArcProposalCommitEntry,
    batch: CommitBatch,
  ) {
    const { description, proposalId, title } = entry;
    const { includeNewer, resolved, unavailable } = await this.resolveAcceptance(
      repository, harness, threadId, entry, { head: batch.head, tree: batch.worktree.tree }, batch.acceptedIds,
    );
    if (unavailable) throw new UnavailableLandingError(unavailable);
    const proposal = resolved.proposal;
    if (proposal.metadata.status !== "proposed") {
      throw new GitArcRejectionError({ reason: "proposalUnavailable" }, proposal.metadata.unavailableReason || "Checkpoint proposal is not available to commit.");
    }
    if (proposal.metadata.mode === "amend" && !proposal.metadata.freshCommitMessage) {
      throw new GitArcRejectionError({ reason: "missingFreshCommitChoice" }, "This amend proposal does not include a fresh commit choice.");
    }
    const store = this.store(repository);
    const proposalSource = await store.readCheckpoint(harness, threadId, proposal.metadata.sourceCheckpoint);
    requireArcMetadata(proposalSource.metadata);
    const sourceIsOwned = await store.lineageContains(harness, threadId, batch.activeSource, proposalSource.checkpointCommit)
      || Boolean(await this.stack(repository).sealingLayer(batch.active, proposalId));
    if (!sourceIsOwned) {
      throw new GitArcRejectionError({ reason: "proposalNotOwned" }, "The proposal no longer belongs to this thread's active Git arc.");
    }
    const message = commitMessage(title, description);
    const committing = proposal.metadata.mode === "amend"
      ? await freshCommitProposal(repository, proposal)
      : { metadata: proposal.metadata, tree: proposal.tree };
    const baseCommit = committing.metadata.baseCommit;
    if (baseCommit !== batch.head) throw acceptanceFailure(new Error("HEAD no longer matches the proposal's base commit."));
    const includingNewer = includeNewer && resolved.includeNewerAvailable;
    const targetTree = includingNewer ? resolved.currentTree! : committing.tree;
    if (targetTree === await repository.resolveTree(baseCommit)) {
      throw new GitArcRejectionError({ reason: "noChangesToPropose" }, "The selected result has no changes to commit.");
    }
    // Commits land at their proposal time so accepted stacks keep their real history; newer work is dated now.
    const proposedAt = includingNewer ? undefined : proposal.metadata.proposedAt;
    const committedSha = await repository.createCommitFromTree(targetTree, baseCommit, message,
      proposedAt ? { authorDate: proposedAt, committerDate: proposedAt } : undefined);
    const { freshCommitMessage: _freshCommitMessage, ...proposalMetadata } = committing.metadata;
    const { commit: stateCommit, metadata: committedMetadata } = await store.createProposalCommit(targetTree, {
      ...proposalMetadata,
      committedSha,
      description: description.trim(),
      status: "committed",
      title: title.trim(),
      unavailableReason: null,
    }, { parent: proposal.metadata.baseCommit, previous: proposal });
    if (!batch.accepted.some((receipt) => receipt.proposalId === proposalId)) {
      batch.accepted.push({ commitSha: committedSha, headSha: committedSha, proposalId });
    }
    batch.landings.push({ committedMetadata, committedSha, proposal, stateCommit, targetTree });
    batch.acceptedIds.add(proposalId);
    batch.head = committedSha;
  }

  /** Publish a batch's landings, one claim transition and one outcome in a single ref transaction. */
  private async publishCommitBatch(repository: WorkbenchGitRepository, harness: GitArcHarness, threadId: string, batch: CommitBatch) {
    const store = this.store(repository);
    const last = batch.landings.at(-1)!;
    const transition = await prepareAcceptedClaimTransition({
      acceptedHead: last.committedSha,
      harness,
      proposalIds: batch.landings.map(({ proposal }) => proposal.metadata.proposalId),
      registry: this.registry(repository),
      resolveThreadIdentity: this.resolveThreadIdentity,
      repository,
      source: batch.activeSource,
      stack: this.stack(repository),
      store,
      threadId,
    });
    const outcomeUpdate = await store.prepareOutcome(harness, threadId, {
      acceptedProposals: batch.accepted,
      committedSha: last.committedSha,
      proposalId: last.proposal.metadata.proposalId,
      sourceCheckpoint: transition.sourceCheckpoint,
      status: transition.status,
      successorCheckpoint: transition.successorCheckpoint,
      version: 1,
    });
    const headRef = await repository.symbolicHead();
    const results = await Promise.all(batch.landings.map(async ({ committedMetadata, committedSha, targetTree }) => (
      await buildProposalResult(this.proposalDiffs, repository, committedMetadata, { tree: targetTree }, {
        amendability: WorkbenchGitHistoryRewriter.freshCommitAmendability(committedSha, headRef),
      })
    )));
    try {
      await repository.publishRefsAfterIndexNormalization({
        indexCommit: last.committedSha,
        paths: [...new Set(batch.landings.flatMap(({ proposal }) => proposal.metadata.livePaths))],
        updates: [
          { newValue: last.committedSha, oldValue: batch.startHead, ref: headRef ?? "HEAD" },
          ...batch.landings.map(({ proposal, stateCommit }): GitRefUpdate => ({
            newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef,
          })),
          outcomeUpdate,
          ...transition.updates,
        ],
      });
    } catch (error) {
      throw acceptanceFailure(error);
    }
    return results;
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
      const { commit: stateCommit } = await store.createProposalCommit(
        proposal.tree,
        { ...proposal.metadata, status: "unavailable", unavailableReason: reason },
        { previous: proposal },
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
    const selected = new GitArcPathSet(paths);
    const covering = await Promise.all(proposalIds.map(async (proposalId) => {
      const proposal = await store.readProposal(normalizeHarness(harness), threadId, proposalId);
      return proposal.metadata.livePaths.some(live => selected.overlaps(live)) ? proposalId : null;
    }));
    return covering.filter(id => id !== null);
  }

  private async requireProposableArc(input: ArcIdentityInput) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = this.registry(repository);
    const active = await registry.find({ harness, threadId: input.threadId });
    const arc = active?.phase === "plan" ? active.retainedArc : active;
    const ownership = active
      ? await new GitArcClaimOwnershipController(repository, this.resolveThreadIdentity).project(active)
      : null;
    if (!active || !arc || arc.phase !== "active" || !ownership?.activeClaims.length) {
      throw new GitArcRejectionError({ reason: "missingActiveArc" }, "This thread does not own active Git arc claims.");
    }
    const checkpoint = await this.store(repository).readCheckpoint(harness, input.threadId, arc.checkpointCommit);
    const metadata = requireArcMetadata(checkpoint.metadata);
    const scope = new Set(metadata.scopePaths);
    const claimsMatch = active.phase === "plan"
      ? arc.claimedPaths.every((claimedPath) => scope.has(claimedPath))
      : metadata.scopePaths.length === arc.claimedPaths.length
        && metadata.scopePaths.every((scopePath, index) => scopePath === arc.claimedPaths[index]);
    if (!claimsMatch) {
      throw new Error("The Git arc registry does not match its checkpoint claim set.");
    }
    return {
      active,
      arc,
      checkpoint,
      claimedPaths: ownership.activeClaims,
      harness,
      metadata,
      proposalIds: arc.proposalIds ?? (active.proposalId ? [active.proposalId] : []),
      registry,
      repository,
    };
  }
}
