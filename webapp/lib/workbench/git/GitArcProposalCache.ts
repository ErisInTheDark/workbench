/*
 * Exports:
 * - default GitArcProposalCache: own bounded in-memory and transcript-backed caches for immutable proposal file changes. Keywords: git, arc, proposal, cache, transcript, LRU, TTL.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  GitCheckpointFileChangeSchema,
  type GitCheckpointFileChange,
} from "./checkpoint-contracts";

const CacheFileSchema = z.object({
  baseTree: z.string().regex(/^[a-f0-9]{40,64}$/u),
  changes: z.array(GitCheckpointFileChangeSchema),
  paths: z.array(z.string().min(1)),
  targetTree: z.string().regex(/^[a-f0-9]{40,64}$/u),
  version: z.literal(1),
});

const DEFAULT_MAX_MEMORY_ENTRIES = 128;
const DEFAULT_MEMORY_TTL_MS = 10 * 60 * 1000;

interface ProposalCacheInput {
  baseTree: string;
  build: () => Promise<GitCheckpointFileChange[]>;
  harness: "codex" | "copilot" | "opencode";
  paths: string[];
  proposalId: string;
  rootPath: string;
  targetTree: string;
  threadId: string;
}

type CacheFile = z.infer<typeof CacheFileSchema>;

interface MemoryCacheEntry {
  changes: GitCheckpointFileChange[];
  expiresAt: number;
}

function pathsEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cacheIdentity(input: Pick<ProposalCacheInput, "baseTree" | "harness" | "paths" | "targetTree">) {
  return createHash("sha256").update(JSON.stringify({
    baseTree: input.baseTree,
    harness: input.harness,
    paths: input.paths,
    targetTree: input.targetTree,
    version: 1,
  })).digest("hex");
}

function encodeTranscriptPathSegment(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function isMissingFileError(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function warnCacheFailure(action: string, proposalId: string, error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  console.warn(`[git-arc-proposal-cache] ${action} failed proposal=${proposalId}${code ? ` code=${code}` : ""}`);
}

export default class GitArcProposalCache {
  private readonly maxMemoryEntries: number;
  private readonly memory = new Map<string, MemoryCacheEntry>();
  private readonly memoryTtlMs: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, Promise<GitCheckpointFileChange[]>>();

  constructor({
    maxMemoryEntries = DEFAULT_MAX_MEMORY_ENTRIES,
    memoryTtlMs = DEFAULT_MEMORY_TTL_MS,
    now = Date.now,
  }: {
    maxMemoryEntries?: number;
    memoryTtlMs?: number;
    now?: () => number;
  } = {}) {
    this.maxMemoryEntries = Math.max(1, Math.trunc(maxMemoryEntries));
    this.memoryTtlMs = Math.max(1, Math.trunc(memoryTtlMs));
    this.now = now;
  }

  async readOrBuild(input: ProposalCacheInput) {
    const identity = this.memoryIdentity(input);
    const cached = this.readMemory(identity);
    if (cached) return cached;

    const existing = this.pending.get(identity);
    if (existing) return await existing;

    const pending = this.readOrBuildDurable(input).then((changes) => {
      this.remember(identity, changes);
      return changes;
    }).finally(() => {
      if (this.pending.get(identity) === pending) this.pending.delete(identity);
    });
    this.pending.set(identity, pending);
    return await pending;
  }

  private async readOrBuildDurable(input: ProposalCacheInput) {
    const cachePath = await this.resolveCachePath(input);
    if (!cachePath) {
      return await input.build();
    }

    const cached = await this.read(cachePath, input);
    if (cached) {
      return cached.changes;
    }

    const changes = await input.build();
    const cacheFile: CacheFile = {
      baseTree: input.baseTree,
      changes,
      paths: input.paths,
      targetTree: input.targetTree,
      version: 1,
    };
    await this.write(cachePath, input.proposalId, cacheFile);
    return changes;
  }

  private memoryIdentity(input: ProposalCacheInput) {
    return [
      path.resolve(input.rootPath),
      input.harness,
      input.threadId.trim(),
      input.proposalId,
      cacheIdentity(input),
    ].join("\0");
  }

  private pruneExpired(now: number) {
    for (const [identity, entry] of this.memory) {
      if (entry.expiresAt <= now) this.memory.delete(identity);
    }
  }

  private readMemory(identity: string) {
    const now = this.now();
    this.pruneExpired(now);
    const entry = this.memory.get(identity);
    if (!entry) return null;
    this.memory.delete(identity);
    this.memory.set(identity, { changes: entry.changes, expiresAt: now + this.memoryTtlMs });
    return entry.changes;
  }

  private remember(identity: string, changes: GitCheckpointFileChange[]) {
    const now = this.now();
    this.pruneExpired(now);
    this.memory.delete(identity);
    this.memory.set(identity, { changes, expiresAt: now + this.memoryTtlMs });
    while (this.memory.size > this.maxMemoryEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  private async resolveCachePath(input: ProposalCacheInput) {
    if (!/^[A-Za-z0-9._-]+$/u.test(input.proposalId) || !input.threadId.trim()) {
      throw new Error("Invalid Git arc proposal cache identity.");
    }
    const threadDirectoryPath = path.join(
      input.rootPath,
      ".workbench",
      "transcripts",
      input.harness,
      "threads",
      encodeTranscriptPathSegment(input.threadId.trim()),
    );
    try {
      const threadFile = await fs.stat(path.join(threadDirectoryPath, "thread.json"));
      if (!threadFile.isFile()) return null;
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
    return path.join(
      threadDirectoryPath,
      "artifacts",
      "git-arc-proposals",
      input.proposalId,
      `${cacheIdentity(input)}.json`,
    );
  }

  private async read(cachePath: string, input: ProposalCacheInput) {
    let text: string;
    try {
      text = await fs.readFile(cachePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return null;
      warnCacheFailure("read", input.proposalId, error);
      return null;
    }

    try {
      const parsed = CacheFileSchema.safeParse(JSON.parse(text));
      if (
        !parsed.success
        || parsed.data.baseTree !== input.baseTree
        || parsed.data.targetTree !== input.targetTree
        || !pathsEqual(parsed.data.paths, input.paths)
      ) {
        warnCacheFailure("validation", input.proposalId, new Error("invalid cache payload"));
        return null;
      }
      return parsed.data;
    } catch (error) {
      warnCacheFailure("parse", input.proposalId, error);
      return null;
    }
  }

  private async write(cachePath: string, proposalId: string, cacheFile: CacheFile) {
    const directoryPath = path.dirname(cachePath);
    const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(directoryPath, { recursive: true });
      await fs.writeFile(temporaryPath, `${JSON.stringify(cacheFile)}\n`, { encoding: "utf8", flag: "wx" });
      try {
        await fs.rename(temporaryPath, cachePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST" && code !== "EPERM") throw error;
        await fs.rm(cachePath, { force: true });
        await fs.rename(temporaryPath, cachePath);
      }
    } catch (error) {
      warnCacheFailure("write", proposalId, error);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
