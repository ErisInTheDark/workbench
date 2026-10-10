/*
 * Exports:
 * - default GitArcHistoryRewriter: remap affected arc objects, reusing content when parent trees are unchanged.
 * - GitArcHistoryRewritePlan: prepared ref updates, deletes, commit aliases and bounded warnings.
 * - GitArcHistoryRewriteOptions: refs excluded from remapping.
 * - remapGitArcClaimLossHead: preserve frozen stash bases and remap ordinary loss boundaries.
 * - COMMIT_REWRITE_MAP_REF: durable commit alias ref.
 */
import GitArcRegistry, { REGISTRY_REF } from "./GitArcRegistry";
import GitObjectReadSession from "./GitObjectReadSession";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { GitArcClaimLossSchema } from "workbench-shared/workbench/git/git-arc-status";
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
} from "workbench-shared/workbench/git/git-arc-storage";

export const COMMIT_REWRITE_MAP_REF = "refs/worktree/workbench/commit-rewrites";

export function remapGitArcClaimLossHead(
  claimLoss: { frozen: boolean; head?: string | null },
  commits: ReadonlyMap<string, string>,
) {
  const head = claimLoss.head ?? null;
  return claimLoss.frozen || head === null
    ? head
    : commits.get(head) ?? head;
}

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

const COMMIT_TOKEN = /(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{40})(?![0-9a-f])/gu;

/** Full commit ids named anywhere in stored metadata text, found without decoding it. */
function commitTokens(text: string) {
  return new Set(text.match(COMMIT_TOKEN) ?? []);
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
    // Edit sessions are parentless snapshot chains outside branch history, so rewrites never touch them.
    const missingRefs = refs.filter(({ objectType, ref }) => (
      objectType === "missing" && /\/(?:(?:arc-outcomes|checkpoint-proposals|checkpoints)\/|claim-loss$|arc-stash$|edit-session$)/u.test(ref)
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
    const claimLossRefs = refs
      .filter(({ objectType, ref }) => objectType === "commit" && /\/claim-loss$/u.test(ref))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const stashRefs = refs.filter(({ objectType, ref }) => objectType === "commit" && ref.endsWith("/arc-stash"));
    const proposalRefs = refs.filter(({ objectType, ref }) => objectType === "commit" && /\/checkpoint-proposals\//u.test(ref));
    const commitBatch = await this.repository.readCommits([
      ...checkpointRefs.map(({ value }) => value),
      ...claimLossRefs.map(({ value }) => value),
      ...stashRefs.map(({ value }) => value),
      ...proposalRefs.map(({ value }) => value),
      ...branchCommits.keys(),
      ...branchCommits.values(),
    ]);
    // Newly prepared commits are not in the batch; their tree identities are known at creation.
    const preparedTrees = new Map<string, string>();
    const treeOf = (commit: string) => {
      const tree = preparedTrees.get(commit) ?? commitBatch.commits.get(commit)?.tree;
      if (!tree) throw new Error(commitBatch.errors.get(commit) ?? "Rewrite parent tree is unavailable.");
      return tree;
    };
    const pendingCheckpoints: Array<{
      entry: (typeof checkpointRefs)[number];
      oldCommit: GitCommitIdentity;
      /** Every full commit id the message names: a superset of the metadata commits remapping can change. */
      tokens: Set<string>;
    }> = [];
    for (const entry of checkpointRefs) {
      await GitObjectReadSession.yieldSlice();
      const oldCommit = commitBatch.commits.get(entry.value);
      if (!oldCommit) {
        warnings.push(`Skipped unreadable checkpoint ref ${entry.ref}: ${commitBatch.errors.get(entry.value) ?? "invalid commit object"}`);
        continue;
      }
      if (oldCommit.parents.length > 1) continue;
      pendingCheckpoints.push({ entry, oldCommit, tokens: commitTokens(oldCommit.message) });
    }
    // Remapping only changes commits already rewritten, so a message naming none of them needs no decode.
    const namesRewrittenCommit = (tokens: ReadonlySet<string>) => {
      for (const token of tokens) if (commits.has(token)) return true;
      return false;
    };
    const rewriteCheckpoint = async ({ entry, oldCommit, tokens }: (typeof pendingCheckpoints)[number]) => {
      const oldParent = oldCommit.parents[0] ?? null;
      const newParent = oldParent === null ? undefined : commits.get(oldParent);
      if (!newParent && !namesRewrittenCommit(tokens)) return;
      const metadata = parseMarkedMetadata<CheckpointMetadata>(oldCommit.message, CHECKPOINT_METADATA_MARKER);
      const remappedMetadata = metadata ? remapCheckpointMetadata(metadata, commits) : null;
      const metadataChanged = Boolean(
        metadata && remappedMetadata && checkpointMessage(metadata) !== checkpointMessage(remappedMetadata),
      );
      if (!newParent && !metadataChanged) return;
      const parent = newParent ?? oldParent;
      let tree = oldCommit.tree;
      if (newParent && oldParent) {
        const parentContentChanged = treeOf(newParent) !== treeOf(oldParent);
        if (!metadata) {
          if (parentContentChanged) tree = await this.repository.mergeTree(oldParent, newParent, entry.value);
        } else if (!metadata.scopePaths.length) {
          tree = treeOf(newParent);
        } else if (parentContentChanged || oldCommit.tree !== treeOf(oldParent)) {
          // Full checkpoints may capture incidental dirt outside their declared rewrite scope.
          tree = await this.repository.writeTreeWithPathsFromSource(newParent, entry.value, metadata.scopePaths);
        }
      }
      const next = await this.repository.createCommitFromTree(
        tree,
        parent,
        remappedMetadata ? checkpointMessage(remappedMetadata) : oldCommit.message,
        oldCommit,
      );
      commits.set(entry.value, next);
      preparedTrees.set(next, tree);
      const nextRef = replaceCheckpointSuffix(entry.ref, next.slice(0, 8));
      if (nextRef === entry.ref) updates.push({ newValue: next, oldValue: entry.value, ref: entry.ref });
      else {
        deletes.push({ oldValue: entry.value, ref: entry.ref });
        updates.push({ newValue: next, oldValue: "0".repeat(40), ref: nextRef });
      }
    };
    // Dependency order in one pass (Kahn): a checkpoint waits for every pending checkpoint its parent or message names,
    // including every ref sharing that commit, so remapping always sees rewritten dependencies.
    const pendingByValue = new Map<string, number>();
    for (const { entry } of pendingCheckpoints) pendingByValue.set(entry.value, (pendingByValue.get(entry.value) ?? 0) + 1);
    const dependents = new Map<string, number[]>();
    const blockers = pendingCheckpoints.map(({ entry, oldCommit, tokens }, index) => {
      const dependencies = new Set([oldCommit.parents[0], ...tokens]
        .filter((dependency): dependency is string => Boolean(dependency && dependency !== entry.value && pendingByValue.has(dependency))));
      for (const dependency of dependencies) {
        const waiting = dependents.get(dependency);
        if (waiting) waiting.push(index);
        else dependents.set(dependency, [index]);
      }
      return dependencies.size;
    });
    const ready = blockers.flatMap((count, index) => count ? [] : [index]);
    for (let cursor = 0; cursor < ready.length; cursor += 1) {
      await GitObjectReadSession.yieldSlice();
      const pending = pendingCheckpoints[ready[cursor]!]!;
      await rewriteCheckpoint(pending);
      const remaining = pendingByValue.get(pending.entry.value)! - 1;
      pendingByValue.set(pending.entry.value, remaining);
      if (remaining) continue;
      for (const dependent of dependents.get(pending.entry.value) ?? []) {
        blockers[dependent]! -= 1;
        if (!blockers[dependent]) ready.push(dependent);
      }
    }
    if (ready.length < pendingCheckpoints.length) {
      const processed = new Set(ready);
      const cycle = pendingCheckpoints.filter((_, index) => !processed.has(index)).map(({ entry }) => entry.ref);
      throw new Error(`Checkpoint metadata contains a dependency cycle: ${cycle.join(", ")}`);
    }

    const invalidClaimLossRefs: string[] = [];
    for (const entry of claimLossRefs) {
      const oldCommit = commitBatch.commits.get(entry.value);
      if (!oldCommit) {
        invalidClaimLossRefs.push(entry.ref);
        continue;
      }
      let stored: ReturnType<typeof GitArcClaimLossSchema.safeParse>;
      try {
        stored = GitArcClaimLossSchema.safeParse(JSON.parse(oldCommit.message));
      } catch {
        invalidClaimLossRefs.push(entry.ref);
        continue;
      }
      if (!stored.success || oldCommit.parents.length > 1 || (oldCommit.parents[0] ?? null) !== stored.data.head) {
        invalidClaimLossRefs.push(entry.ref);
        continue;
      }
      const head = remapGitArcClaimLossHead(stored.data, commits);
      if (head === stored.data.head) continue;
      const next = await this.repository.createCommitFromTree(
        oldCommit.tree,
        head,
        JSON.stringify({ ...stored.data, head }),
        oldCommit,
      );
      commits.set(entry.value, next);
      preparedTrees.set(next, oldCommit.tree);
      updates.push({ newValue: next, oldValue: entry.value, ref: entry.ref });
    }
    for (const ref of invalidClaimLossRefs.slice(0, 20)) {
      warnings.push(`Skipped invalid claim-loss ref ${ref}.`);
    }
    if (invalidClaimLossRefs.length > 20) {
      warnings.push(`Skipped ${invalidClaimLossRefs.length - 20} additional invalid claim-loss refs.`);
    }

    for (const entry of proposalRefs) {
      await GitObjectReadSession.yieldSlice();
      const oldCommit = commitBatch.commits.get(entry.value);
      if (!oldCommit) {
        warnings.push(`Skipped unreadable proposal ref ${entry.ref}: ${commitBatch.errors.get(entry.value) ?? "invalid commit object"}`);
        continue;
      }
      if (oldCommit.parents.length > 1) continue;
      const oldParent = oldCommit.parents[0] ?? null;
      const newParent = oldParent === null ? undefined : commits.get(oldParent);
      if (!newParent && !namesRewrittenCommit(commitTokens(oldCommit.message))) continue;
      const metadata = parseMarkedMetadata<ProposalMetadata>(oldCommit.message, PROPOSAL_METADATA_MARKER);
      if (!newParent && !metadata) continue;
      const remapped = metadata ? remapProposalMetadata(metadata, commits) : null;
      const metadataChanged = remapped && proposalMessage(remapped) !== proposalMessage(metadata!);
      if (!newParent && !metadataChanged) continue;
      const parent = newParent ?? oldParent;
      // An amend's tree holds its target's content, so a rewritten target (which includes any rewritten parent) must flow in.
      const oldTarget = metadata?.amendTargetSha ?? null;
      const newTarget = oldTarget === null ? undefined : commits.get(oldTarget);
      const tree = oldTarget !== null && newTarget
        ? await this.repository.mergeTree(oldTarget, newTarget, entry.value)
        : newParent && oldParent && treeOf(newParent) !== treeOf(oldParent)
        ? await this.repository.mergeTree(oldParent, newParent, entry.value)
        : oldCommit.tree;
      const next = await this.repository.createCommitFromTree(tree, parent, remapped ? proposalMessage(remapped) : oldCommit.message, oldCommit);
      commits.set(entry.value, next);
      preparedTrees.set(next, tree);
      updates.push({ newValue: next, oldValue: entry.value, ref: entry.ref });
    }

    const outcomeRefs = refs.filter(({ objectType, ref }) => objectType === "blob" && /\/arc-outcomes\//u.test(ref));
    const outcomeBlobs = await this.repository.readBlobs(outcomeRefs.map(({ value }) => value));
    for (const entry of outcomeRefs) {
      await GitObjectReadSession.yieldSlice();
      const error = outcomeBlobs.errors.get(entry.value);
      if (error) throw new Error(error);
      const contents = outcomeBlobs.blobs.get(entry.value)?.contents;
      if (contents === undefined) throw new Error(`Git object ${entry.value} is missing.`);
      if (!namesRewrittenCommit(commitTokens(contents))) continue;
      const outcome = JSON.parse(contents) as ArcOutcome;
      const remapped = remapArcOutcome(outcome, commits);
      if (areDeeplyEqual(remapped, outcome)) continue;
      const blob = await this.repository.writeBlob(`${JSON.stringify(remapped)}\n`);
      const nextRef = entry.ref.replace(/\/[^/]+$/u, `/${remapped.sourceCheckpoint}`);
      if (nextRef === entry.ref) updates.push({ newValue: blob, oldValue: entry.value, ref: entry.ref });
      else {
        deletes.push({ oldValue: entry.value, ref: entry.ref });
        updates.push({ newValue: blob, oldValue: "0".repeat(40), ref: nextRef });
      }
    }

    for (const entry of stashRefs) {
      const oldCommit = commitBatch.commits.get(entry.value);
      if (!oldCommit) {
        warnings.push(`Skipped unreadable saved-work ref ${entry.ref}.`);
        continue;
      }
      let frozen: ReturnType<typeof GitArcClaimLossSchema.safeParse>;
      try { frozen = GitArcClaimLossSchema.safeParse(JSON.parse(oldCommit.message)); }
      catch { throw new Error("Saved work has invalid frozen snapshot metadata."); }
      if (!frozen.success || !frozen.data.frozen || oldCommit.parents.length > 1
        || (oldCommit.parents[0] ?? null) !== frozen.data.head) {
        throw new Error("Saved work has invalid frozen snapshot metadata.");
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
