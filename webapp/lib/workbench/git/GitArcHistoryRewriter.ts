/*
 * Exports:
 * - default GitArcHistoryRewriter: rebuild affected Git-backed arc objects and prepare one atomic ref remap. Keywords: git, arc, checkpoint, proposal, rewrite.
 * - GitArcHistoryRewritePlan: prepared ref updates, deletes, commit aliases, and bounded warnings. Keywords: git, transaction, sha, alias.
 */
import GitArcRegistry, { REGISTRY_REF } from "./GitArcRegistry";
import WorkbenchGitRepository, { type GitCommitIdentity, type GitRefUpdate } from "./WorkbenchGitRepository";
import {
  CHECKPOINT_METADATA_MARKER,
  PROPOSAL_METADATA_MARKER,
  checkpointMessage,
  type CheckpointMetadata,
  parseMarkedMetadata,
  proposalMessage,
  type ProposalMetadata,
  remapArcOutcome,
  remapCheckpointMetadata,
  remapProposalMetadata,
  type ArcOutcome,
} from "./git-arc-storage";

export const COMMIT_REWRITE_MAP_REF = "refs/worktree/workbench/commit-rewrites";

export interface GitArcHistoryRewritePlan {
  commits: Map<string, string>;
  deletes: Array<{ oldValue: string; ref: string }>;
  updates: GitRefUpdate[];
  warnings: string[];
}

export interface GitArcHistoryRewriteOptions {
  excludeRefs?: Iterable<string>;
}

function replaceCheckpointSuffix(ref: string, shortCommit: string) {
  return ref.replace(/-[a-f0-9]{7,64}$/iu, `-${shortCommit}`);
}

export default class GitArcHistoryRewriter {
  constructor(private readonly repository: WorkbenchGitRepository) {}

  async resolveAlias(commit: string) {
    const resolved = await this.repository.readBlobAtRef(COMMIT_REWRITE_MAP_REF);
    if (!resolved) return commit;
    const aliases = JSON.parse(resolved.contents) as Record<string, string>;
    let current = commit;
    const seen = new Set<string>();
    while (aliases[current] && !seen.has(current)) {
      seen.add(current);
      current = aliases[current]!;
    }
    return current;
  }

  async prepare(
    branchCommits: ReadonlyMap<string, string>,
    options: GitArcHistoryRewriteOptions = {},
  ): Promise<GitArcHistoryRewritePlan> {
    const commits = new Map(branchCommits);
    const updates: GitRefUpdate[] = [];
    const deletes: Array<{ oldValue: string; ref: string }> = [];
    const warnings: string[] = [];
    const excludedRefs = new Set(options.excludeRefs ?? []);
    const refs = (await this.repository.listRefsWithValues("refs/worktree/agents"))
      .filter(({ ref }) => !excludedRefs.has(ref));
    const missingRefs = refs.filter(({ objectType, ref }) => (
      objectType === "missing" && /\/(?:arc-outcomes|checkpoint-proposals|checkpoints)\//u.test(ref)
    ));
    for (const entry of missingRefs.slice(0, 20)) {
      warnings.push(`Skipped unreadable Workbench ref ${entry.ref}: missing object ${entry.value}`);
    }
    if (missingRefs.length > 20) {
      warnings.push(`Skipped ${missingRefs.length - 20} additional unreadable Workbench refs with missing objects.`);
    }

    const checkpointRefs = refs
      .filter(({ objectType, ref }) => objectType === "commit" && /\/checkpoints\//u.test(ref))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const proposalRefs = refs.filter(({ objectType, ref }) => objectType === "commit" && /\/checkpoint-proposals\//u.test(ref));
    const commitBatch = await this.repository.readCommits([
      ...checkpointRefs.map(({ value }) => value),
      ...proposalRefs.map(({ value }) => value),
    ]);
    const pendingCheckpoints: Array<{
      entry: (typeof checkpointRefs)[number];
      metadata: CheckpointMetadata | null;
      oldCommit: GitCommitIdentity;
    }> = [];
    for (const entry of checkpointRefs) {
      const oldCommit = commitBatch.commits.get(entry.value);
      if (!oldCommit) {
        warnings.push(`Skipped unreadable checkpoint ref ${entry.ref}: ${commitBatch.errors.get(entry.value) ?? "invalid commit object"}`);
        continue;
      }
      if (oldCommit.parents.length !== 1) continue;
      pendingCheckpoints.push({
        entry,
        metadata: parseMarkedMetadata<CheckpointMetadata>(oldCommit.message, CHECKPOINT_METADATA_MARKER),
        oldCommit,
      });
    }
    while (pendingCheckpoints.length) {
      const pendingValues = new Set(pendingCheckpoints.map(({ entry }) => entry.value));
      const index = pendingCheckpoints.findIndex(({ entry, metadata, oldCommit }) => (
        [oldCommit.parents[0], metadata?.amendedFrom]
          .filter((dependency): dependency is string => Boolean(dependency && dependency !== entry.value))
          .every((dependency) => !pendingValues.has(dependency))
      ));
      if (index < 0) break;
      const [{ entry, metadata, oldCommit }] = pendingCheckpoints.splice(index, 1);
      const newParent = commits.get(oldCommit.parents[0]!);
      const remappedMetadata = metadata ? remapCheckpointMetadata(metadata, commits) : null;
      const metadataChanged = Boolean(
        metadata && remappedMetadata && checkpointMessage(metadata) !== checkpointMessage(remappedMetadata),
      );
      if (!newParent && !metadataChanged) continue;
      const parent = newParent ?? oldCommit.parents[0]!;
      const tree = newParent
        ? await this.repository.mergeTree(oldCommit.parents[0]!, newParent, entry.value)
        : oldCommit.tree;
      const next = await this.repository.createCommitFromTree(
        tree,
        parent,
        remappedMetadata ? checkpointMessage(remappedMetadata) : oldCommit.message,
        oldCommit,
      );
      commits.set(entry.value, next);
      const nextRef = replaceCheckpointSuffix(entry.ref, next.slice(0, 8));
      if (nextRef === entry.ref) updates.push({ newValue: next, oldValue: entry.value, ref: entry.ref });
      else {
        deletes.push({ oldValue: entry.value, ref: entry.ref });
        updates.push({ newValue: next, oldValue: "0".repeat(40), ref: nextRef });
      }
    }
    if (pendingCheckpoints.length) {
      throw new Error(`Checkpoint metadata contains a dependency cycle: ${pendingCheckpoints.map(({ entry }) => entry.ref).join(", ")}`);
    }

    for (const entry of proposalRefs) {
      const oldCommit = commitBatch.commits.get(entry.value);
      if (!oldCommit) {
        warnings.push(`Skipped unreadable proposal ref ${entry.ref}: ${commitBatch.errors.get(entry.value) ?? "invalid commit object"}`);
        continue;
      }
      if (oldCommit.parents.length !== 1) continue;
      const newParent = commits.get(oldCommit.parents[0]!);
      const metadata = parseMarkedMetadata<ProposalMetadata>(oldCommit.message, PROPOSAL_METADATA_MARKER);
      if (!newParent && !metadata) continue;
      const remapped = metadata ? remapProposalMetadata(metadata, commits) : null;
      const metadataChanged = remapped && proposalMessage(remapped) !== proposalMessage(metadata!);
      if (!newParent && !metadataChanged) continue;
      const parent = newParent ?? oldCommit.parents[0]!;
      const tree = newParent ? await this.repository.mergeTree(oldCommit.parents[0]!, parent, entry.value) : oldCommit.tree;
      const next = await this.repository.createCommitFromTree(tree, parent, remapped ? proposalMessage(remapped) : oldCommit.message, oldCommit);
      commits.set(entry.value, next);
      updates.push({ newValue: next, oldValue: entry.value, ref: entry.ref });
    }

    for (const entry of refs.filter(({ objectType, ref }) => objectType === "blob" && /\/arc-outcomes\//u.test(ref))) {
      const outcome = JSON.parse(await this.repository.readBlob(entry.value)) as ArcOutcome;
      const remapped = remapArcOutcome(outcome, commits);
      if (JSON.stringify(remapped) === JSON.stringify(outcome)) continue;
      const blob = await this.repository.writeBlob(`${JSON.stringify(remapped)}\n`);
      const nextRef = entry.ref.replace(/\/[^/]+$/u, `/${remapped.sourceCheckpoint}`);
      if (nextRef === entry.ref) updates.push({ newValue: blob, oldValue: entry.value, ref: entry.ref });
      else {
        deletes.push({ oldValue: entry.value, ref: entry.ref });
        updates.push({ newValue: blob, oldValue: "0".repeat(40), ref: nextRef });
      }
    }

    const registryUpdate = excludedRefs.has(REGISTRY_REF)
      ? null
      : await new GitArcRegistry(this.repository).prepareCommitRemap(commits);
    if (registryUpdate) updates.push(registryUpdate);

    const priorMapObject = await this.repository.readBlobAtRef(COMMIT_REWRITE_MAP_REF);
    const priorMapBlob = priorMapObject?.blob ?? null;
    const priorMap = priorMapObject ? JSON.parse(priorMapObject.contents) as Record<string, string> : {};
    const nextMap = Object.fromEntries(Object.entries(priorMap).map(([oldCommit, current]) => [oldCommit, commits.get(current) ?? current]));
    for (const [oldCommit, next] of commits) if (oldCommit !== next) nextMap[oldCommit] = next;
    const mapBlob = await this.repository.writeBlob(`${JSON.stringify(nextMap)}\n`);
    updates.push({ newValue: mapBlob, oldValue: priorMapBlob ?? "0".repeat(40), ref: COMMIT_REWRITE_MAP_REF });
    return { commits, deletes, updates, warnings };
  }
}
