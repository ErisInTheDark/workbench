/*
 * Exports:
 * - default GitArcProposalController: own proposal creation, replacement, rescission, acceptance, receipts, and lifecycle projection. Keywords: git, arc, proposal, acceptance, lifecycle.
 * - GitArcLifecycleState: durable active or resolved arc projection with ordered visible proposal summaries. Keywords: git, arc, lifecycle, sidebar, proposals.
 * - GitCheckpointProposalReceipt: durable proposal identity returned after proposal publication. Keywords: git, proposal, receipt, commit.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type { GitCheckpointProposal } from "./checkpoint-contracts";
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import GitArcProposalCache from "./GitArcProposalCache";
import GitArcPublishState from "./GitArcPublishState";
import GitArcRegistry, { REGISTRY_REF, type GitArcRegistryEntry } from "./GitArcRegistry";
import GitCheckpointStore, { type StoredProposal } from "./GitCheckpointStore";
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
} from "./git-arc-storage";

const execFileAsync = promisify(execFile);

interface ArcIdentityInput {
  cwd: string;
  harness?: GitArcHarness;
  threadId: string;
}

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

function acceptedReceiptMessage(receipts: Array<{ commitSha: string; proposalId: string }>) {
  return [
    "Accepted commit proposals:",
    ...receipts.map(({ commitSha, proposalId }) => `- ${proposalId} -> ${commitSha}`),
    "",
    "The current Git arc still owns its previous claim set.",
    "Run wb git arc plan start -m <intent> -- <path> [...] with the explicit next paths when the approved plan is unchanged.",
    "Run wb git arc plan -m <intent> -- <path> [...] when the plan changed.",
  ].join("\n");
}

function requireArcMetadata(metadata: CheckpointMetadata | null) {
  if (!metadata || (metadata.kind !== "arc" && metadata.kind !== "implement") || !metadata.scopePaths.length) {
    throw new Error("This checkpoint does not contain a claimed file set. Create a new plan with wb git arc plan.");
  }
  return metadata;
}

function pathIsCoveredBy(candidate: string, scopePath: string) {
  return candidate === scopePath || candidate.startsWith(`${scopePath}/`);
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

function literalPathspec(relativePath: string) {
  return `:(literal)${relativePath}`;
}

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
  return await new GitArcProposalCache(repository.root).readOrBuild({
    baseTree,
    build: async () => await repository.buildFileChanges(metadata.baseCommit, target, metadata.paths),
    harness,
    paths: metadata.paths,
    proposalId: metadata.proposalId,
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
  return {
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
  if (proposal.metadata.status === "proposed") {
    const headMovement = await repository.classifyHeadMovement(proposal.metadata.liveBaseCommit, proposal.metadata.livePaths);
    let unavailableReason: string | null = headMovement.kind === "incompatible"
      ? "The repository HEAD moved incompatibly after this proposal was created."
      : headMovement.changedPaths.length
        ? `Proposed paths changed in committed history: ${headMovement.changedPaths.join(", ")}`
        : null;
    if (!unavailableReason && proposal.metadata.mode === "amend" && headMovement.kind !== "same") {
      unavailableReason = "Repository HEAD changed after this amend proposal was created.";
    }
    if (!unavailableReason && proposal.metadata.mode === "commit" && headMovement.kind === "fast-forward") {
      const rebasedTree = await repository.writeTreeWithPathsFromSource(
        headMovement.currentHead,
        proposal.proposalCommit,
        proposal.metadata.paths,
      );
      proposal = await transitionProposal(repository, proposal, {
        ...proposal.metadata,
        baseCommit: headMovement.currentHead,
        liveBaseCommit: headMovement.currentHead,
      }, rebasedTree);
    }
    if (!unavailableReason) {
      currentTree = await repository.writeScopedWorktreeTree(proposal.metadata.livePaths, proposal.metadata.liveBaseCommit);
      const changedNow = new Set(await repository.listChangedPaths(
        proposal.metadata.liveBaseCommit,
        currentTree,
        proposal.metadata.livePaths,
      ));
      const cleanPath = proposal.metadata.livePaths.find((filePath) => !changedNow.has(filePath));
      if (cleanPath) unavailableReason = `${cleanPath} no longer has working-tree changes.`;
    }
    if (unavailableReason) {
      proposal = await transitionProposal(repository, proposal, {
        ...proposal.metadata,
        status: "unavailable",
        unavailableReason,
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
    return projected.map(({ entry, lifecycle }, index) => ({
      checkpointCommit: lifecycle!.checkpointCommit,
      claimedPaths: lifecycle!.claimedPaths,
      harness: entry.harness,
      intentDescription: lifecycle!.intentDescription,
      intentName: lifecycle!.intentName,
      phase: lifecycle!.phase,
      proposals: (summaries[index] ?? []).flatMap(({ proposalId, status }) => (
        status === "proposed" || status === "committed" ? [{ proposalId, status }] : []
      )),
      threadId: entry.threadId,
      updatedAt: entry.updatedAt,
    }));
  }

  async findLifecycleState(input: ArcIdentityInput) {
    const states = await this.listLifecycleStates({ cwd: input.cwd });
    const harness = normalizeHarness(input.harness);
    return states.find((state) => state.harness === harness && state.threadId === input.threadId) ?? null;
  }

  async requireNoAcceptedReceipts(input: ArcIdentityInput & { checkpointCommit: string }) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const outcome = await new GitCheckpointStore(repository).readOutcome(harness, input.threadId, input.checkpointCommit);
    const receipts = outcome?.acceptedProposals ?? [];
    if (receipts.length) throw new Error(acceptedReceiptMessage(receipts));
  }

  async logicalBaseline(input: ArcIdentityInput & { checkpointCommit: string; fallbackHead: string }) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const outcome = await new GitCheckpointStore(repository).readOutcome(harness, input.threadId, input.checkpointCommit);
    return outcome?.acceptedProposals?.at(-1)?.headSha ?? input.fallbackHead;
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
    const { active, checkpoint, harness, metadata: checkpointMetadata, registry, repository } = await this.requireActiveArc({ cwd, harness: rawHarness, threadId });
    const proposalIds = active.proposalIds ?? (active.proposalId ? [active.proposalId] : []);
    const store = new GitCheckpointStore(repository);
    let replacementTarget: StoredProposal | null = null;
    if (replaceProposalId) {
      if (!proposalIds.includes(replaceProposalId)) throw new Error("The replacement target does not belong to this Git arc.");
      replacementTarget = await store.readProposal(harness, threadId, replaceProposalId);
      if (replacementTarget.metadata.status === "committed") {
        throw new Error(`Proposal ${replaceProposalId} is already committed. Use wb git arc propose --amend ${replaceProposalId}.`);
      }
      if (replacementTarget.metadata.status !== "proposed") throw new Error("Only a pending proposal can be replaced.");
    }
    let amendTargetProposal: StoredProposal | null = null;
    if (amendProposalId) {
      if (!proposalIds.includes(amendProposalId)) throw new Error("The amend target does not belong to this Git arc.");
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
      ? await repository.listChangedPaths(baseCommit, proposalTree, ["."])
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

  async rescindProposal(input: ArcIdentityInput & { proposalId: string }) {
    const repository = await WorkbenchGitRepository.open(input.cwd);
    const harness = normalizeHarness(input.harness);
    const registry = new GitArcRegistry(repository);
    const entry = await registry.find({ harness, threadId: input.threadId });
    const lifecycle = entry ? lifecycleEntry(entry) : null;
    if (!entry || !lifecycle || !lifecycle.proposalIds.includes(input.proposalId)) {
      throw new Error("The proposal does not belong to this thread's current Git arc.");
    }
    const proposal = await new GitCheckpointStore(repository).readProposal(harness, input.threadId, input.proposalId);
    if (proposal.metadata.status === "committed") {
      throw new Error(`Proposal ${input.proposalId} is already committed. Use wb git arc propose --amend ${input.proposalId}.`);
    }
    if (proposal.metadata.status !== "proposed") throw new Error("Only a pending proposal can be rescinded.");
    const metadata = { ...proposal.metadata, status: "rescinded" as const, unavailableReason: null };
    const stateCommit = await repository.createCommitFromTree(proposal.tree, metadata.baseCommit, proposalMessage(metadata));
    await repository.updateRefs([{ newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef }]);
    return { committedSha: null, proposalId: metadata.proposalId, status: metadata.status };
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
    if (proposal.metadata.status !== "proposed") {
      throw new Error(proposal.metadata.unavailableReason || "Checkpoint proposal is not available to commit.");
    }
    const store = new GitCheckpointStore(repository);
    if (proposal.metadata.mode === "amend") {
      const message = commitMessage(title, description);
      const targetTree = includeNewer && resolved.includeNewerAvailable ? resolved.currentTree! : proposal.tree;
      const source = await store.readCheckpoint(harness, threadId, proposal.metadata.sourceCheckpoint);
      requireArcMetadata(source.metadata);
      const registry = new GitArcRegistry(repository);
      const active = await registry.find({ harness, threadId });
      if (!active || active.phase !== "active" || active.checkpointCommit !== source.checkpointCommit) {
        throw new Error("The proposal no longer belongs to this thread's active Git arc.");
      }
      const oldOutcomeRef = outcomeRef(harness, threadId, source.checkpointCommit);
      const previousOutcome = await store.readOutcome(harness, threadId, source.checkpointCommit);
      const supersededProposalId = previousOutcome?.acceptedProposals?.slice().reverse().find((receipt) => (
        receipt.commitSha === proposal.metadata.amendTargetSha && receipt.proposalId !== proposalId
      ))?.proposalId ?? (
        previousOutcome?.committedSha === proposal.metadata.amendTargetSha && previousOutcome.proposalId !== proposalId
          ? previousOutcome.proposalId
          : null
      );
      const supersededPrior = supersededProposalId
        ? await store.readProposal(harness, threadId, supersededProposalId)
        : await store.findCommittedProposalBySha(harness, threadId, proposal.metadata.amendTargetSha, proposalId);
      let committedMetadata: ProposalMetadata | null = null;
      const rewritten = await new WorkbenchGitHistoryRewriter(repository).amend({
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
          const remappedSource = arcPlan.commits.get(source.checkpointCommit) ?? source.checkpointCommit;
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
          const registryUpdate = await registry.prepareCommitRemap(arcPlan.commits);
          if (registryUpdate) updates.push(registryUpdate);
          const oldOutcome = await repository.readRef(oldOutcomeRef);
          const nextOutcomeRef = outcomeRef(harness, threadId, remappedSource);
          const remappedOutcome = previousOutcome ? remapArcOutcome(previousOutcome, arcPlan.commits) : null;
          const acceptedProposals = [...(remappedOutcome?.acceptedProposals ?? [])];
          acceptedProposals.push({ commitSha: amendedCommit, headSha: newHead, proposalId });
          const outcomeBlob = await repository.writeBlob(`${JSON.stringify({
            acceptedProposals,
            committedSha: amendedCommit,
            proposalId,
            sourceCheckpoint: remappedSource,
            status: "committed",
            successorCheckpoint: null,
            version: 1,
          } satisfies ArcOutcome)}\n`);
          updates.push({
            newValue: outcomeBlob,
            oldValue: oldOutcomeRef === nextOutcomeRef ? oldOutcome ?? "0".repeat(40) : "0".repeat(40),
            ref: nextOutcomeRef,
          });
          replaceRefs.push(oldOutcomeRef, nextOutcomeRef);
          return {
            deletes: oldOutcome && oldOutcomeRef !== nextOutcomeRef ? [{ oldValue: oldOutcome, ref: oldOutcomeRef }] : [],
            replaceRefs,
            updates,
          };
        },
      });
      if (!committedMetadata) throw new Error("Amend proposal metadata was not committed.");
      return await buildProposalResult(repository, committedMetadata, rewritten.amendedCommit, harness, threadId);
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
    const source = await store.readCheckpoint(harness, threadId, proposal.metadata.sourceCheckpoint);
    const registry = new GitArcRegistry(repository);
    const active = await registry.find({ harness, threadId });
    if (!active || active.phase !== "active" || active.checkpointCommit !== source.checkpointCommit) {
      throw new Error("The proposal no longer belongs to this thread's active Git arc.");
    }
    const previousOutcome = await store.readOutcome(harness, threadId, source.checkpointCommit);
    const acceptedProposals = [...(previousOutcome?.acceptedProposals ?? [])];
    if (!acceptedProposals.some((receipt) => receipt.proposalId === proposalId)) {
      acceptedProposals.push({ commitSha: committedSha, headSha: committedSha, proposalId });
    }
    const outcomeUpdate = await store.prepareOutcome(harness, threadId, {
      acceptedProposals,
      committedSha,
      proposalId,
      sourceCheckpoint: source.checkpointCommit,
      status: "committed",
      successorCheckpoint: null,
      version: 1,
    });
    const headRef = await repository.symbolicHead() ?? "HEAD";
    await repository.updateRefs([
      { newValue: committedSha, oldValue: proposal.metadata.liveBaseCommit, ref: headRef },
      { newValue: stateCommit, oldValue: proposal.proposalCommit, ref: proposal.proposalRef },
      outcomeUpdate,
    ]);
    await execFileAsync("git", [
      "reset", "--mixed", "--quiet", committedSha, "--", ...proposal.metadata.livePaths.map(literalPathspec),
    ], { cwd: repository.root, encoding: "utf8", windowsHide: true });
    return await buildProposalResult(repository, committedMetadata, committedSha, harness, threadId);
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
