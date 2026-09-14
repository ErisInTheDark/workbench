/*
 * Exports:
 * - GitClaimHistoryDiscovery: typed checkpoint candidates plus unsupported history count.
 * - default GitClaimHistoryReader: decode actual Workbench claim checkpoints and expand declared scopes to workspace files.
 */
import path from "node:path";

import type { WorkbenchHarness } from "workbench-shared/types";
import {
  CHECKPOINT_METADATA_MARKER,
  parseMarkedMetadata,
  type CheckpointMetadata,
} from "workbench-shared/workbench/git/git-arc-storage";
import type { WorkbenchGitClaimImportDiscovery } from "../../../database/stats/WorkbenchStatsImportRepository";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

export interface GitClaimHistoryDiscovery {
  candidates: WorkbenchGitClaimImportDiscovery[];
  unsupported: number;
}

function parseIdentity(ref: string): { harness: WorkbenchHarness; threadId: string } | null {
  const canonical = /^refs\/worktree\/agents\/([a-z][a-z0-9_-]*)\/([^/]+)\/checkpoints\//u.exec(ref);
  if (canonical) return { harness: canonical[1] as WorkbenchHarness, threadId: canonical[2]! };
  const legacy = /^refs\/worktree\/agents\/([^/]+)\/checkpoints\//u.exec(ref);
  return legacy ? { harness: "codex", threadId: legacy[1]! } : null;
}

function activeMetadata(message: string) {
  if (!message.trimStart().startsWith(CHECKPOINT_METADATA_MARKER)) return null;
  const metadata = parseMarkedMetadata<CheckpointMetadata>(message, CHECKPOINT_METADATA_MARKER);
  if (
    !metadata
    || (metadata.kind !== "arc" && metadata.kind !== "implement")
    || !Array.isArray(metadata.scopePaths)
    || metadata.scopePaths.some((candidate) => typeof candidate !== "string" || !candidate.trim())
  ) return null;
  return metadata;
}

function comparable(value: string) {
  const normalized = path.resolve(value).replace(/\\/gu, "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseGitActorDate(value: string) {
  const match = /^(\d+) [+-]\d{4}$/u.exec(value.trim());
  if (!match) return null;
  const timestamp = Number(match[1]) * 1_000;
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function relativeWithin(candidate: string, root: string) {
  const absolute = path.resolve(candidate);
  const relative = path.relative(root, absolute).replace(/\\/gu, "/");
  return relative === "" ? "." : relative.startsWith("../") || path.isAbsolute(relative) ? null : relative;
}

export default class GitClaimHistoryReader {
  async discover(input: { projectId: string; rootId: string; workspaceRoot: string }): Promise<GitClaimHistoryDiscovery> {
    const repository = await WorkbenchGitRepository.tryOpen(input.workspaceRoot);
    if (!repository) return { candidates: [], unsupported: 0 };
    const refs = await repository.listRefsWithValues("refs/worktree/agents");
    const checkpointRefs = refs.filter(({ objectType, ref }) => objectType === "commit" && ref.includes("/checkpoints/"));
    const commits = await repository.readCommits(checkpointRefs.map(({ value }) => value));
    const candidates: WorkbenchGitClaimImportDiscovery[] = [];
    let unsupported = 0;
    for (const entry of checkpointRefs) {
      const identity = commits.commits.get(entry.value);
      const owner = parseIdentity(entry.ref);
      if (!identity || !owner) {
        unsupported += 1;
        continue;
      }
      let metadata: CheckpointMetadata | null;
      try {
        metadata = activeMetadata(identity.message);
      } catch {
        unsupported += 1;
        continue;
      }
      if (!metadata) {
        if (!identity.message.trimStart().startsWith(CHECKPOINT_METADATA_MARKER)) unsupported += 1;
        continue;
      }
      const observedAt = parseGitActorDate(identity.committerDate);
      if (observedAt === null) {
        unsupported += 1;
        continue;
      }
      candidates.push({
        checkpointCommit: entry.value,
        checkpointRef: entry.ref,
        harness: owner.harness,
        observedAt,
        projectId: input.projectId,
        repositoryRoot: repository.root,
        rootId: input.rootId,
        threadId: owner.threadId,
        workspaceRoot: path.resolve(input.workspaceRoot),
      });
    }
    return { candidates, unsupported };
  }

  async hydrate(candidate: WorkbenchGitClaimImportDiscovery) {
    const repository = new WorkbenchGitRepository(candidate.repositoryRoot);
    if (await repository.readRef(candidate.checkpointRef) !== candidate.checkpointCommit) {
      throw new Error(`Claim checkpoint ref changed before import: ${candidate.checkpointRef}`);
    }
    const commit = await repository.readCommit(candidate.checkpointCommit);
    const metadata = activeMetadata(commit.message);
    if (!metadata) throw new Error(`Claim checkpoint metadata is unavailable: ${candidate.checkpointRef}`);
    const expanded = await this.expandTreeScopes(repository, commit.tree, metadata.scopePaths);
    const paths = new Set<string>();
    for (const repoPath of expanded) {
      const relative = relativeWithin(path.resolve(repository.root, repoPath), candidate.workspaceRoot);
      if (relative) paths.add(relative);
    }
    return [...paths].sort((left, right) => comparable(left).localeCompare(comparable(right)));
  }

  async expandScopes(input: {
    checkpointCommit: string;
    repositoryRoot: string;
    scopePaths: string[];
  }) {
    const repository = new WorkbenchGitRepository(input.repositoryRoot);
    const commit = await repository.readCommit(input.checkpointCommit);
    return await this.expandTreeScopes(repository, commit.tree, input.scopePaths);
  }

  private async expandTreeScopes(
    repository: WorkbenchGitRepository,
    tree: string,
    scopePaths: string[],
  ) {
    const scopes = repository.normalizePaths(scopePaths);
    const paths = new Set(await repository.listTreePaths(tree, scopes));
    for (const scope of scopes) {
      const hasExpandedPath = scope === "."
        ? paths.size > 0
        : [...paths].some((candidate) => candidate === scope || candidate.startsWith(`${scope}/`));
      if (!hasExpandedPath) paths.add(scope);
    }
    return [...paths].sort((left, right) => comparable(left).localeCompare(comparable(right)));
  }
}
