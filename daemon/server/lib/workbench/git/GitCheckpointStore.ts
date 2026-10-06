/*
 * Exports:
 * - default GitCheckpointStore: own canonical writes and WB-first/provider-fallback checkpoint, lineage, outcome, history, and proposal reads.
 * - GitArcProposalSummary: normalized proposal identity, status and commit message facts, read in bulk without diffs.
 * - GitArcProposalSummaryRequest: thread-qualified proposal summary selection.
 * - StoredCheckpoint: owned checkpoint identity, metadata, and nullable parent.
 * - StoredProposal: owned proposal identity, metadata, and tree.
 * - GitCheckpointMissingObjectError: preserve a requested checkpoint ref that Git cannot resolve.
 */
import GitObjectReadSession from "./GitObjectReadSession";
import WorkbenchGitRepository, { type GitCommitIdentity, type GitRefUpdate } from "./WorkbenchGitRepository";
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import {
  type ArcOutcome,
  CHECKPOINT_METADATA_MARKER,
  checkpointMessage,
  checkpointNamespace,
  type CheckpointMetadata,
  type GitArcHarness,
  type GitArcProposalStatus,
  normalizeArcOutcome,
  outcomeRef,
  parseMarkedMetadata,
  PROPOSAL_METADATA_MARKER,
  proposalNamespace,
  legacyProposalNamespace,
  legacyCheckpointNamespace,
  normalizeCommit,
  type ProposalMetadata,
} from "workbench-shared/workbench/git/git-arc-storage";
import {
  gitArcThreadStorageIds,
  passthroughGitArcThreadIdentityResolver,
  type GitArcThreadIdentityResolver,
} from "./git-arc-thread-identity";

/** Metadata-only proposal facts: enough to decide and perform a commit, without building diffs. */
export interface GitArcProposalSummary {
  committedSha: string | null;
  description: string;
  hasChanges: boolean;
  mode: "amend" | "commit";
  proposalId: string;
  status: GitArcProposalStatus;
  title: string;
}

export interface GitArcProposalSummaryRequest {
  harness: GitArcHarness;
  proposalIds: string[];
  threadId: string;
}

export interface StoredCheckpoint {
  checkpointCommit: string;
  checkpointRef: string;
  metadata: CheckpointMetadata | null;
  parent: string | null;
}

export interface StoredProposal {
  metadata: ProposalMetadata;
  proposalCommit: string;
  proposalRef: string;
  tree: string;
}

export class GitCheckpointMissingObjectError extends Error {
  constructor(readonly requestedRef: string) {
    super(`Git object ${requestedRef} is missing.`);
    this.name = "GitCheckpointMissingObjectError";
  }
}

function validateOutcome(value: Partial<ArcOutcome>, sourceCheckpoint: string) {
  if (
    value.version !== 1
    || value.sourceCheckpoint !== sourceCheckpoint
    || !["committed", "continued", "partial", "proposed", "released"].includes(value.status ?? "")
  ) throw new Error("Arc outcome metadata is invalid.");
  return value as ArcOutcome;
}

function normalizeProposalMetadata(metadata: ProposalMetadata): ProposalMetadata {
  return metadata.version === 1
    ? {
      ...metadata,
      amendTargetSha: null,
      liveBaseCommit: metadata.baseCommit,
      livePaths: metadata.paths,
      mode: "commit",
      supersededByProposalId: null,
      supersededBySha: null,
    }
    : metadata;
}

export default class GitCheckpointStore {
  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  private async identity(harness: GitArcHarness, threadId: string) {
    const identity = await this.resolveThreadIdentity({ harness, repositoryRoot: this.repository.root, threadId });
    if (!identity) throw new Error("The Git arc owner identity is unavailable.");
    return identity;
  }

  private async checkpointNamespaces(harness: GitArcHarness, threadId: string) {
    return [...new Set(gitArcThreadStorageIds(await this.identity(harness, threadId))
      .flatMap(id => [checkpointNamespace(harness, id), legacyCheckpointNamespace(id)]))];
  }

  private async proposalNamespaces(harness: GitArcHarness, threadId: string) {
    return [...new Set(gitArcThreadStorageIds(await this.identity(harness, threadId))
      .flatMap(id => [proposalNamespace(harness, id), legacyProposalNamespace(id)]))];
  }

  async proposalRefName(harness: GitArcHarness, threadId: string, proposalId: string) {
    return `${proposalNamespace(harness, (await this.identity(harness, threadId)).threadId)}/${proposalId}`;
  }

  async readOutcome(harness: GitArcHarness, threadId: string, sourceCheckpoint: string) {
    const refs = gitArcThreadStorageIds(await this.identity(harness, threadId))
      .map(id => outcomeRef(harness, id, sourceCheckpoint));
    const resolved = (await this.repository.readBlobs(refs)).blobs;
    const value = refs.map(ref => resolved.get(ref)).find(candidate => candidate);
    if (!value) return null;
    return await this.decodeOutcome(value.contents, sourceCheckpoint);
  }

  private async decodeOutcome(contents: string, sourceCheckpoint: string) {
    const outcome = validateOutcome(JSON.parse(contents) as Partial<ArcOutcome>, sourceCheckpoint);
    return outcome.acceptedProposals
      ? normalizeArcOutcome(outcome)
      : normalizeArcOutcome(outcome, await this.repository.currentHead());
  }

  /**
   * Every owned checkpoint by commit, from one ref listing and one batched commit read, shared until the operation next
   * publishes refs. Checkpoint commits are immutable, so an unindexed one only falls back to readCheckpoint.
   */
  private async checkpointIndex(harness: GitArcHarness, threadId: string) {
    const namespaces = await this.checkpointNamespaces(harness, threadId);
    const { byCommit, commits } = await GitObjectReadSession.memo(`${this.repository.refMemoPrefix()}checkpoint-index:${namespaces.join("|")}`, async () => {
      const refs = await this.repository.listRefsWithValues(...namespaces);
      const byCommit = new Map<string, (typeof refs)[number]>();
      for (const ref of refs) if (!byCommit.has(ref.value)) byCommit.set(ref.value, ref);
      return { byCommit, commits: await this.repository.readCommits([...byCommit.keys()]) };
    });
    return {
      commits: [...byCommit.keys()],
      /** The checkpoint at `commit`, or null when the index cannot decode it (callers fall back to readCheckpoint). */
      decode: (commit: string) => {
        const entry = byCommit.get(normalizeCommit(commit));
        const identity = entry && commits.commits.get(entry.value);
        return entry && identity ? this.decodeCheckpoint(entry.value, entry.ref, identity) : null;
      },
    };
  }

  /** Whether `required` is `start` or one of the checkpoints it amends, at most 100 steps back. */
  async lineageContains(harness: GitArcHarness, threadId: string, start: StoredCheckpoint, required: string) {
    if (start.checkpointCommit === required) return true;
    if (!start.metadata?.amendedFrom) return false;
    const index = await this.checkpointIndex(harness, threadId);
    let cursor = start;
    for (let depth = 0; depth < 100; depth += 1) {
      if (cursor.checkpointCommit === required) return true;
      const parent = cursor.metadata?.amendedFrom;
      if (!parent) return false;
      // Aliases and unindexed entries keep readCheckpoint's resolution and ownership errors.
      cursor = index.decode(parent) ?? await this.readCheckpoint(harness, threadId, parent);
    }
    return false;
  }

  async readAcceptedOutcomes(harness: GitArcHarness, threadId: string, start: string | StoredCheckpoint) {
    let checkpoint = typeof start === "string" ? await this.readCheckpoint(harness, threadId, start) : start;
    if (!checkpoint.metadata?.amendedFrom || checkpoint.metadata.kind === "plan") {
      return (await this.readOutcome(harness, threadId, checkpoint.checkpointCommit))?.acceptedProposals ?? [];
    }
    const index = await this.checkpointIndex(harness, threadId);
    const outcomes = await this.repository.readBlobs(gitArcThreadStorageIds(await this.identity(harness, threadId)).flatMap(id => (
      [...new Set([checkpoint.checkpointCommit, ...index.commits])].map(commit => outcomeRef(harness, id, commit))
    )));
    while (true) {
      const outcomeRefs = gitArcThreadStorageIds(await this.identity(harness, threadId))
        .map(id => outcomeRef(harness, id, checkpoint.checkpointCommit));
      const ref = outcomeRefs.find(candidate => outcomes.blobs.has(candidate) || outcomes.errors.has(candidate)) ?? outcomeRefs[0]!;
      const error = outcomes.errors.get(ref);
      if (error) throw new Error(error);
      const blob = outcomes.blobs.get(ref);
      const outcome = outcomes.blobs.has(ref)
        ? blob ? await this.decodeOutcome(blob.contents, checkpoint.checkpointCommit) : null
        : await this.readOutcome(harness, threadId, checkpoint.checkpointCommit);
      if (outcome?.acceptedProposals?.length) return outcome.acceptedProposals;
      const parent = checkpoint.metadata?.amendedFrom;
      if (!parent || checkpoint.metadata?.kind === "plan") return [];
      // Preserve alias resolution and the existing ownership/missing-object errors.
      checkpoint = index.decode(parent) ?? await this.readCheckpoint(harness, threadId, parent);
    }
  }

  async prepareOutcome(harness: GitArcHarness, threadId: string, outcome: ArcOutcome): Promise<GitRefUpdate> {
    const ref = outcomeRef(harness, (await this.identity(harness, threadId)).threadId, outcome.sourceCheckpoint);
    const previous = await this.repository.readRef(ref);
    const normalized = normalizeArcOutcome(outcome);
    const blob = await this.repository.writeBlob(`${JSON.stringify(normalized)}\n`);
    return { newValue: blob, oldValue: previous ?? "0".repeat(40), ref };
  }

  async readProposalSummaries(harness: GitArcHarness, threadId: string, proposalIds: string[]) {
    return (await this.readProposalSummaryGroups([{ harness, proposalIds, threadId }]))[0] ?? [];
  }

  async readProposalSummaryGroups(requests: GitArcProposalSummaryRequest[]) {
    const resolvedRequests = await Promise.all(requests.map(async request => ({
      ...request,
      namespaces: request.proposalIds.length ? await this.proposalNamespaces(request.harness, request.threadId) : [],
    })));
    const namespaces = [...new Set(resolvedRequests.flatMap(request => request.namespaces))];
    if (!namespaces.length) return requests.map(() => []);
    const refs = await this.repository.listRefsWithValues(...namespaces);
    const byRef = new Map(refs.map((entry) => [entry.ref, entry]));
    const selections = resolvedRequests.map(({ namespaces: requestNamespaces, proposalIds }) => {
      return [...new Set(proposalIds)].map((proposalId) => ({
        entry: requestNamespaces.map(namespace => byRef.get(`${namespace}/${proposalId}`)).find(entry => entry) ?? null,
        proposalId,
      }));
    });
    const commits = await this.repository.readCommits(selections.flatMap((selection) => selection.flatMap(({ entry }) => entry ? [entry.value] : [])));
    const missing = (proposalId: string): GitArcProposalSummary => ({
      committedSha: null, description: "", hasChanges: false, mode: "commit", proposalId, status: "unavailable", title: "",
    });
    return selections.map((selection) => selection.map(({ entry, proposalId }): GitArcProposalSummary => {
      if (!entry) return missing(proposalId);
      const identity = commits.commits.get(entry.value);
      if (!identity) return missing(proposalId);
      const parsed = parseMarkedMetadata<ProposalMetadata>(identity.message, PROPOSAL_METADATA_MARKER);
      if (!parsed || parsed.proposalId !== proposalId) return missing(proposalId);
      const metadata = normalizeProposalMetadata(parsed);
      return {
        committedSha: metadata.committedSha, description: metadata.description, hasChanges: metadata.paths.length > 0,
        mode: metadata.mode, proposalId, status: metadata.status, title: metadata.title,
      };
    }));
  }

  checkpointRefName(harness: GitArcHarness, threadId: string, commit: string) {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
    return `${checkpointNamespace(harness, threadId)}/${timestamp}-${normalizeCommit(commit)}`;
  }

  async createCheckpoint(harness: GitArcHarness, threadId: string, tree: string, parent: string | null, metadata: CheckpointMetadata) {
    const prepared = await this.prepareCheckpoint(harness, threadId, tree, parent, metadata);
    await this.repository.updateRefs([prepared.update]);
    return { checkpointCommit: prepared.checkpointCommit, checkpointRef: prepared.checkpointRef };
  }

  async prepareCheckpoint(harness: GitArcHarness, threadId: string, tree: string, parent: string | null, metadata: CheckpointMetadata) {
    const checkpointCommit = await this.repository.createCommitFromTree(tree, parent, checkpointMessage(metadata));
    const checkpointRef = this.checkpointRefName(harness, (await this.identity(harness, threadId)).threadId, checkpointCommit);
    return {
      checkpointCommit,
      checkpointRef,
      update: { newValue: checkpointCommit, oldValue: "0".repeat(40), ref: checkpointRef },
    };
  }

  async readCheckpoint(harness: GitArcHarness, threadId: string, rawCommit: string): Promise<StoredCheckpoint> {
    const namespaces = await this.checkpointNamespaces(harness, threadId);
    const original = normalizeCommit(rawCommit);
    if (original.length === 40 || original.length === 64) {
      const owned = await this.repository.readCommitRef(original, ...namespaces);
      if (owned) {
        return this.decodeCheckpoint(original, owned.ref, owned.identity);
      }
    }
    let checkpointCommit = original;
    let resolved = await this.repository.readCommitAt(checkpointCommit);
    if (!resolved) throw new GitCheckpointMissingObjectError(original);
    let refs = await this.repository.refsPointingAt(checkpointCommit, ...namespaces);
    if (!refs.length) {
      checkpointCommit = await new GitArcHistoryRewriter(this.repository).resolveAlias(checkpointCommit);
      resolved = await this.repository.readCommitAt(checkpointCommit);
      if (!resolved) throw new GitCheckpointMissingObjectError(original);
      refs = await this.repository.refsPointingAt(checkpointCommit, ...namespaces);
    }
    if (!refs.length) throw new GitArcRejectionError({ reason: "wrongCheckpointOwnership" }, "Checkpoint commit is not in this thread/worktree checkpoint timeline.");
    return this.decodeCheckpoint(checkpointCommit, refs[0]!, resolved.identity);
  }

  private decodeCheckpoint(checkpointCommit: string, checkpointRef: string, identity: GitCommitIdentity): StoredCheckpoint {
    if (identity.parents.length > 1) throw new Error("Checkpoint commit parent metadata is invalid.");
    return {
      checkpointCommit, checkpointRef,
      metadata: parseMarkedMetadata<CheckpointMetadata>(identity.message, CHECKPOINT_METADATA_MARKER),
      parent: identity.parents[0] ?? null,
    };
  }

  async readProposal(harness: GitArcHarness, threadId: string, proposalId: string): Promise<StoredProposal> {
    const normalizedProposalId = String(proposalId ?? "").trim();
    if (!/^[A-Za-z0-9._-]+$/u.test(normalizedProposalId)) throw new GitArcRejectionError({ reason: "invalidProposalId" }, "Invalid checkpoint proposal id.");
    const refs = (await this.proposalNamespaces(harness, threadId)).map(namespace => `${namespace}/${normalizedProposalId}`);
    let proposalRef = refs[0]!;
    let resolved = null;
    for (const ref of refs) {
      resolved = await this.repository.readCommitAt(ref);
      if (resolved) {
        proposalRef = ref;
        break;
      }
    }
    if (!resolved) throw new GitArcRejectionError({ reason: "proposalNotFound", proposalId: normalizedProposalId }, "Checkpoint proposal not found.");
    const parsed = parseMarkedMetadata<ProposalMetadata>(resolved.identity.message, PROPOSAL_METADATA_MARKER);
    if (!parsed || parsed.proposalId !== normalizedProposalId) throw new Error("Checkpoint proposal metadata is invalid.");
    return { metadata: normalizeProposalMetadata(parsed), proposalCommit: resolved.commit, proposalRef, tree: resolved.identity.tree };
  }

  async findCommittedProposalBySha(
    harness: GitArcHarness,
    threadId: string,
    committedSha: string,
    excludedProposalId?: string,
  ): Promise<StoredProposal | null> {
    const namespaces = await this.proposalNamespaces(harness, threadId);
    const refs = (await this.repository.listRefsWithValues("refs/worktree/agents"))
      .filter(({ ref }) => namespaces.some((namespace) => ref.startsWith(`${namespace}/`)));
    const commits = await this.repository.readCommits(refs.map(({ value }) => value));
    for (const { ref, value } of refs) {
      const identity = commits.commits.get(value);
      if (!identity) continue;
      const parsed = parseMarkedMetadata<ProposalMetadata>(identity.message, PROPOSAL_METADATA_MARKER);
      if (!parsed) continue;
      const metadata = normalizeProposalMetadata(parsed);
      if (
        metadata.proposalId !== excludedProposalId
        && metadata.status === "committed"
        && metadata.committedSha === committedSha
      ) {
        return { metadata, proposalCommit: value, proposalRef: ref, tree: identity.tree };
      }
    }
    return null;
  }
}
