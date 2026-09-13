/*
 * Exports:
 * - GitArcProposalDiffCacheIdentity: immutable proposal diff identity used by durable cache stores.
 * - GitArcProposalDiffCacheValue: one validated immutable proposal diff projection.
 * - GitArcProposalDiffCacheInput: one cache-or-build request with cancellable Git work.
 * - GitArcProposalDiffStore: durable completed-result cache boundary.
 * - default GitArcProposalDiffController: coalesce and bound cancellable proposal diff builds.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import type { GitCheckpointFileChange } from "workbench-shared/workbench/git/checkpoint-contracts";

const DEFAULT_MAX_CONCURRENT_BUILDS = 2;
const DEFAULT_MAX_STORED_BYTES = 256 * 1024 * 1024;

export interface GitArcProposalDiffCacheIdentity {
  baseTree: string;
  key: string;
  paths: string[];
  repositoryRoot: string;
  targetTree: string;
  version: 1;
}

export interface GitArcProposalDiffCacheValue extends GitArcProposalDiffCacheIdentity {
  changes: GitCheckpointFileChange[];
}

export interface GitArcProposalDiffCacheInput {
  baseTree: string;
  build(signal: AbortSignal): Promise<GitCheckpointFileChange[]>;
  paths: string[];
  repositoryRoot: string;
  targetTree: string;
}

export interface GitArcProposalDiffStore {
  read(identity: GitArcProposalDiffCacheIdentity): Promise<GitCheckpointFileChange[] | null>;
  write(value: GitArcProposalDiffCacheValue, maxBytes: number): Promise<void>;
}

interface QueuedBuild {
  build(signal: AbortSignal): Promise<GitCheckpointFileChange[]>;
  reject(error: Error): void;
  resolve(changes: GitCheckpointFileChange[]): void;
}

function cacheIdentity(input: GitArcProposalDiffCacheInput): GitArcProposalDiffCacheIdentity {
  const identity = {
    baseTree: input.baseTree,
    paths: [...input.paths],
    repositoryRoot: path.resolve(input.repositoryRoot),
    targetTree: input.targetTree,
    version: 1 as const,
  };
  return {
    ...identity,
    key: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
  };
}

function boundedWarning(action: string, error: unknown) {
  const cause = (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?")
    .slice(0, 500);
  return `[git-arc-proposal-diff] SQLite ${action} failed: ${cause}`;
}

export default class GitArcProposalDiffController {
  private activeBuildCount = 0;
  private readonly disposal = new AbortController();
  private readonly maxConcurrentBuilds: number;
  private readonly maxStoredBytes: number;
  private readonly onWarning: (message: string) => void;
  private readonly pendingByImmutableKey = new Map<string, Promise<GitCheckpointFileChange[]>>();
  private readonly queuedBuilds: QueuedBuild[] = [];
  private readonly store: GitArcProposalDiffStore | null;

  constructor({
    maxConcurrentBuilds = DEFAULT_MAX_CONCURRENT_BUILDS,
    maxStoredBytes = DEFAULT_MAX_STORED_BYTES,
    onWarning = message => console.warn(message),
    store = null,
  }: {
    maxConcurrentBuilds?: number;
    maxStoredBytes?: number;
    onWarning?: (message: string) => void;
    store?: GitArcProposalDiffStore | null;
  } = {}) {
    this.maxConcurrentBuilds = Math.max(1, Math.trunc(maxConcurrentBuilds));
    this.maxStoredBytes = Math.max(1, Math.trunc(maxStoredBytes));
    this.onWarning = onWarning;
    this.store = store;
  }

  async readOrBuild(input: GitArcProposalDiffCacheInput) {
    if (this.disposal.signal.aborted) throw this.disposalError();
    const identity = cacheIdentity(input);
    const existing = this.pendingByImmutableKey.get(identity.key);
    if (existing) return await existing;
    const pending = this.readBuildAndStore(identity, input.build).finally(() => {
      if (this.pendingByImmutableKey.get(identity.key) === pending) {
        this.pendingByImmutableKey.delete(identity.key);
      }
    });
    this.pendingByImmutableKey.set(identity.key, pending);
    return await pending;
  }

  dispose() {
    if (this.disposal.signal.aborted) return;
    const error = new Error("Git arc proposal diff controller disposed.");
    this.disposal.abort(error);
    for (const queued of this.queuedBuilds.splice(0)) queued.reject(error);
  }

  private async readBuildAndStore(
    identity: GitArcProposalDiffCacheIdentity,
    build: GitArcProposalDiffCacheInput["build"],
  ) {
    if (this.store) {
      try {
        const cached = await this.store.read(identity);
        if (cached) return cached;
      } catch (error) {
        this.onWarning(boundedWarning("read", error));
      }
    }
    const changes = await this.enqueueBuild(build);
    if (this.store) {
      try {
        await this.store.write({ ...identity, changes }, this.maxStoredBytes);
      } catch (error) {
        this.onWarning(boundedWarning("write", error));
      }
    }
    return changes;
  }

  private enqueueBuild(build: GitArcProposalDiffCacheInput["build"]) {
    if (this.disposal.signal.aborted) return Promise.reject(this.disposalError());
    return new Promise<GitCheckpointFileChange[]>((resolve, reject) => {
      this.queuedBuilds.push({ build, reject, resolve });
      this.drainQueue();
    });
  }

  private drainQueue() {
    while (
      !this.disposal.signal.aborted
      && this.activeBuildCount < this.maxConcurrentBuilds
      && this.queuedBuilds.length
    ) {
      const queued = this.queuedBuilds.shift()!;
      this.activeBuildCount += 1;
      void queued.build(this.disposal.signal).then(queued.resolve, queued.reject).finally(() => {
        this.activeBuildCount -= 1;
        this.drainQueue();
      });
    }
  }

  private disposalError() {
    const reason = this.disposal.signal.reason;
    return reason instanceof Error ? reason : new Error("Git arc proposal diff controller disposed.");
  }
}
