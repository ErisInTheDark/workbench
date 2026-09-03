/*
 * Exports:
 * - default GitCheckpointStore: own durable checkpoint outcome and batched proposal metadata reads for one repository. Keywords: git, checkpoint, proposal, outcome, batch.
 * - GitArcProposalSummary: normalized proposal identity and terminal status used by lifecycle projection. Keywords: git, proposal, summary, status.
 * - GitCheckpointMissingObjectError: preserve a requested checkpoint ref that Git cannot resolve. Keywords: git, checkpoint, missing, ref, error.
 */
import WorkbenchGitRepository, { type GitRefUpdate } from "./WorkbenchGitRepository";
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
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

export interface GitArcProposalSummary {
  committedSha: string | null;
  proposalId: string;
  status: GitArcProposalStatus;
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
  parent: string;
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
  constructor(private readonly repository: WorkbenchGitRepository) {}

  async readOutcome(harness: GitArcHarness, threadId: string, sourceCheckpoint: string) {
    const resolved = await this.repository.readBlobAtRef(outcomeRef(harness, threadId, sourceCheckpoint));
    if (!resolved) return null;
    const outcome = validateOutcome(JSON.parse(resolved.contents) as Partial<ArcOutcome>, sourceCheckpoint);
    return outcome.acceptedProposals
      ? normalizeArcOutcome(outcome)
      : normalizeArcOutcome(outcome, await this.repository.currentHead());
  }

  async prepareOutcome(harness: GitArcHarness, threadId: string, outcome: ArcOutcome): Promise<GitRefUpdate> {
    const ref = outcomeRef(harness, threadId, outcome.sourceCheckpoint);
    const previous = await this.repository.readRef(ref);
    const normalized = normalizeArcOutcome(outcome);
    const blob = await this.repository.writeBlob(`${JSON.stringify(normalized)}\n`);
    return { newValue: blob, oldValue: previous ?? "0".repeat(40), ref };
  }

  async readProposalSummaries(harness: GitArcHarness, threadId: string, proposalIds: string[]) {
    return (await this.readProposalSummaryGroups([{ harness, proposalIds, threadId }]))[0] ?? [];
  }

  async readProposalSummaryGroups(requests: GitArcProposalSummaryRequest[]) {
    const namespaces = [...new Set(requests.flatMap(({ harness, proposalIds, threadId }) => (
      proposalIds.length ? [proposalNamespace(harness, threadId), legacyProposalNamespace(threadId)] : []
    )))];
    if (!namespaces.length) return requests.map(() => []);
    const refs = await this.repository.listRefsWithValues(...namespaces);
    const byRef = new Map(refs.map((entry) => [entry.ref, entry]));
    const selections = requests.map(({ harness, proposalIds, threadId }) => {
      const canonical = proposalNamespace(harness, threadId);
      const legacy = legacyProposalNamespace(threadId);
      return [...new Set(proposalIds)].map((proposalId) => ({
        entry: byRef.get(`${canonical}/${proposalId}`) ?? byRef.get(`${legacy}/${proposalId}`) ?? null,
        proposalId,
      }));
    });
    const commits = await this.repository.readCommits(selections.flatMap((selection) => selection.flatMap(({ entry }) => entry ? [entry.value] : [])));
    return selections.map((selection) => selection.map(({ entry, proposalId }): GitArcProposalSummary => {
      if (!entry) return { committedSha: null, proposalId, status: "unavailable" };
      const identity = commits.commits.get(entry.value);
      if (!identity) return { committedSha: null, proposalId, status: "unavailable" };
      const parsed = parseMarkedMetadata<ProposalMetadata>(identity.message, PROPOSAL_METADATA_MARKER);
      if (!parsed || parsed.proposalId !== proposalId) return { committedSha: null, proposalId, status: "unavailable" };
      const metadata = normalizeProposalMetadata(parsed);
      return { committedSha: metadata.committedSha, proposalId, status: metadata.status };
    }));
  }

  checkpointRefName(harness: GitArcHarness, threadId: string, commit: string) {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
    return `${checkpointNamespace(harness, threadId)}/${timestamp}-${normalizeCommit(commit)}`;
  }

  async createCheckpoint(harness: GitArcHarness, threadId: string, tree: string, parent: string, metadata: CheckpointMetadata) {
    const prepared = await this.prepareCheckpoint(harness, threadId, tree, parent, metadata);
    await this.repository.updateRefs([prepared.update]);
    return { checkpointCommit: prepared.checkpointCommit, checkpointRef: prepared.checkpointRef };
  }

  async prepareCheckpoint(harness: GitArcHarness, threadId: string, tree: string, parent: string, metadata: CheckpointMetadata) {
    const checkpointCommit = await this.repository.createCommitFromTree(tree, parent, checkpointMessage(metadata));
    const checkpointRef = this.checkpointRefName(harness, threadId, checkpointCommit);
    return {
      checkpointCommit,
      checkpointRef,
      update: { newValue: checkpointCommit, oldValue: "0".repeat(40), ref: checkpointRef },
    };
  }

  async readCheckpoint(harness: GitArcHarness, threadId: string, rawCommit: string): Promise<StoredCheckpoint> {
    const original = normalizeCommit(rawCommit);
    let checkpointCommit = original;
    let resolved = await this.repository.readCommitAt(checkpointCommit);
    if (!resolved) throw new GitCheckpointMissingObjectError(original);
    let refs = await this.repository.refsPointingAt(checkpointCommit, checkpointNamespace(harness, threadId), legacyCheckpointNamespace(threadId));
    if (!refs.length) {
      checkpointCommit = await new GitArcHistoryRewriter(this.repository).resolveAlias(checkpointCommit);
      resolved = await this.repository.readCommitAt(checkpointCommit);
      if (!resolved) throw new GitCheckpointMissingObjectError(original);
      refs = await this.repository.refsPointingAt(checkpointCommit, checkpointNamespace(harness, threadId), legacyCheckpointNamespace(threadId));
    }
    if (!refs.length) throw new Error("Checkpoint commit is not in this thread/worktree checkpoint timeline.");
    if (resolved.identity.parents.length !== 1) throw new Error("Checkpoint commit parent metadata is invalid.");
    return {
      checkpointCommit,
      checkpointRef: refs[0]!,
      metadata: parseMarkedMetadata<CheckpointMetadata>(resolved.identity.message, CHECKPOINT_METADATA_MARKER),
      parent: resolved.identity.parents[0]!,
    };
  }

  async readProposal(harness: GitArcHarness, threadId: string, proposalId: string): Promise<StoredProposal> {
    const normalizedProposalId = String(proposalId ?? "").trim();
    if (!/^[A-Za-z0-9._-]+$/u.test(normalizedProposalId)) throw new Error("Invalid checkpoint proposal id.");
    const canonicalRef = `${proposalNamespace(harness, threadId)}/${normalizedProposalId}`;
    const legacyRef = `${legacyProposalNamespace(threadId)}/${normalizedProposalId}`;
    const canonical = await this.repository.readCommitAt(canonicalRef);
    const proposalRef = canonical ? canonicalRef : legacyRef;
    const resolved = canonical ?? await this.repository.readCommitAt(legacyRef);
    if (!resolved) throw new Error("Checkpoint proposal not found.");
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
    const namespaces = [proposalNamespace(harness, threadId), legacyProposalNamespace(threadId)];
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
