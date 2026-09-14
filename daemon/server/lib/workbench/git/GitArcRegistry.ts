/*
 * Exports:
 * - default GitArcRegistry: preserve raw rows while owning canonical live claims and final-loss snapshot publication.
 * - REGISTRY_REF: worktree-owned registry address.
 * - GitArcIdentity: registry owner identity.
 * - GitArcRegistryEntry: stored arc lifecycle and claims.
 * - GitArcRegistryMutation: prepared canonical state and ref updates.
 * - GitArcRegistryReplaceOptions: replacement guards, remaps and claim-loss snapshot.
 * - GitArcCollision: overlapping sibling claims.
 * - GitArcCollisionError: conflicting ownership rejection.
 * - findGitArcCollisions: detect overlapping live sibling claims.
 * - getGitArcLiveClaimPaths: derive live claims from arc lifecycle.
 */
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { DaemonReloadScope } from "workbench-shared/types";
import { gitArcPathsOverlap } from "workbench-shared/workbench/git/git-arc-paths";
import WorkbenchGitRepository, { type GitRefUpdate, type GitWorktreeSnapshot } from "./WorkbenchGitRepository";
import GitArcClaimLossStore from "./GitArcClaimLossStore";
import {
  passthroughGitArcThreadIdentityResolver,
  type GitArcThreadIdentityResolver,
} from "./git-arc-thread-identity";

export const REGISTRY_REF = "refs/worktree/workbench/active-arcs";

export interface GitArcIdentity {
  harness: string;
  threadId: string;
}

export interface GitArcRegistryEntry extends GitArcIdentity {
  checkpointCommit: string;
  claimedPaths: string[];
  intentDescription: string;
  intentName: string;
  phase?: "active" | "plan" | "resolved";
  proposalId?: string | null;
  proposalIds?: string[];
  reloadScopes?: DaemonReloadScope[];
  retainedArc?: {
    checkpointCommit: string;
    claimedPaths: string[];
    intentDescription: string;
    intentName: string;
    phase: "active" | "resolved";
    proposalIds: string[];
    reloadScopes?: DaemonReloadScope[];
  } | null;
  updatedAt: string;
}

export function getGitArcLiveClaimPaths(entry: Pick<GitArcRegistryEntry, "claimedPaths" | "phase" | "retainedArc">) {
  if (entry.phase === "resolved") return [];
  if (entry.phase === "plan") return entry.retainedArc?.claimedPaths ?? entry.claimedPaths;
  return entry.claimedPaths;
}

export interface GitArcCollision {
  entry: GitArcRegistryEntry;
  overlaps: Array<{ claimedPath: string; requestedPath: string }>;
}

export class GitArcCollisionError extends Error {
  constructor(readonly collisions: GitArcCollision[]) {
    const details = collisions.map(({ entry, overlaps }) => (
      `${entry.harness}/${entry.threadId} (${entry.intentName}): ${overlaps.map(({ claimedPath, requestedPath }) => `${claimedPath} <> ${requestedPath}`).join(", ")}`
    ));
    super(`Arc claims overlap active sibling work: ${details.join("; ")}`);
    this.name = "GitArcCollisionError";
  }
}

interface GitArcRegistryState {
  entries: GitArcRegistryEntry[];
  version: 1;
}

export interface GitArcRegistryMutation {
  nextState: GitArcRegistryState;
  updates: GitRefUpdate[];
}

export interface GitArcRegistryReplaceOptions {
  commitRemaps?: ReadonlyMap<string, string>;
  expectedCheckpointCommit?: string;
  claimLossSnapshot?: GitWorktreeSnapshot;
}

function normalizeIdentityPart(value: string, label: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) throw new Error(`An arc ${label} is required.`);
  return normalized;
}

function identityKey(identity: GitArcIdentity) {
  return `${normalizeIdentityPart(identity.harness, "harness")}\0${normalizeIdentityPart(identity.threadId, "thread id")}`;
}

export function findGitArcCollisions(
  entries: readonly GitArcRegistryEntry[],
  identity: GitArcIdentity,
  requestedPaths: readonly string[],
) {
  const key = identityKey(identity);
  return entries
    .filter((candidate) => identityKey(candidate) !== key)
    .filter((candidate) => getGitArcLiveClaimPaths(candidate).length > 0)
    .map((candidate): GitArcCollision => ({
      entry: candidate,
      overlaps: getGitArcLiveClaimPaths(candidate).flatMap((claimedPath) => requestedPaths
        .filter((requestedPath) => gitArcPathsOverlap(claimedPath, requestedPath))
        .map((requestedPath) => ({ claimedPath, requestedPath }))),
    }))
    .filter((collision) => collision.overlaps.length > 0);
}

function parseState(contents: string): GitArcRegistryState {
  const parsed = JSON.parse(contents) as Partial<GitArcRegistryState>;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("The active arc registry is invalid.");
  return {
    entries: parsed.entries.map((entry) => {
      const proposalIds = Array.isArray(entry.proposalIds)
        ? entry.proposalIds.filter((proposalId): proposalId is string => typeof proposalId === "string" && Boolean(proposalId.trim()))
        : entry.proposalId ? [entry.proposalId] : [];
      const phase = entry.phase ?? "active";
      const { reloadScopes: _storedReloadScopes, ...storedEntry } = entry;
      const retainedArc = entry.retainedArc;
      const storedRetainedArc = retainedArc ? (() => {
        const { reloadScopes: _storedRetainedReloadScopes, ...value } = retainedArc;
        return value;
      })() : null;
      return {
        ...storedEntry,
        claimedPaths: phase === "resolved" ? [] : entry.claimedPaths,
        phase,
        proposalId: proposalIds.at(-1) ?? null,
        proposalIds,
        retainedArc: storedRetainedArc ? {
          ...storedRetainedArc,
          intentDescription: entry.retainedArc.intentDescription ?? entry.intentDescription,
          intentName: entry.retainedArc.intentName ?? entry.intentName,
          phase: entry.retainedArc.phase ?? "active",
          proposalIds: entry.retainedArc.proposalIds ?? [],
        } : null,
      };
    }),
    version: 1,
  };
}

function remapState(state: GitArcRegistryState, commits?: ReadonlyMap<string, string>): GitArcRegistryState {
  if (!commits?.size) return state;
  return {
    entries: state.entries.map((entry) => ({
      ...entry,
      checkpointCommit: commits.get(entry.checkpointCommit) ?? entry.checkpointCommit,
      ...(entry.retainedArc ? {
        retainedArc: {
          ...entry.retainedArc,
          checkpointCommit: commits.get(entry.retainedArc.checkpointCommit) ?? entry.retainedArc.checkpointCommit,
        },
      } : {}),
    })),
    version: 1,
  };
}

export default class GitArcRegistry {
  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  private async readStored() {
    const resolved = await this.repository.readBlobAtRef(REGISTRY_REF);
    if (!resolved) return { blob: null, state: { entries: [], version: 1 } satisfies GitArcRegistryState };
    return { blob: resolved.blob, state: parseState(resolved.contents) };
  }

  private async resolveIdentity(identity: GitArcIdentity) {
    return await this.resolveThreadIdentity({
      harness: identity.harness,
      repositoryRoot: this.repository.root,
      threadId: identity.threadId,
    });
  }

  private async resolveEntries(entries: readonly GitArcRegistryEntry[]) {
    const candidates = await Promise.all(entries.map(async raw => {
      const identity = await this.resolveIdentity(raw);
      return identity ? { raw, resolved: { ...raw, threadId: identity.threadId } } : null;
    }));
    return candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  }

  private async prepareMutation(
    nextState: GitArcRegistryState,
    update: GitRefUpdate | null,
    current: GitArcRegistryEntry | null,
    next: GitArcRegistryEntry | null,
    snapshot?: GitWorktreeSnapshot,
  ): Promise<GitArcRegistryMutation> {
    const updates = update ? [update] : [];
    const previousClaims = current ? getGitArcLiveClaimPaths(current) : [];
    if (update && current && previousClaims.length && (!next || !getGitArcLiveClaimPaths(next).length)) {
      updates.push(await new GitArcClaimLossStore(this.repository).prepare(next ?? current, previousClaims, snapshot));
    }
    return { nextState, updates };
  }

  async read() {
    const stored = await this.readStored();
    const entries = (await this.resolveEntries(stored.state.entries)).map(candidate => candidate.resolved);
    return { blob: stored.blob, state: { entries, version: 1 } satisfies GitArcRegistryState };
  }

  async find(identity: GitArcIdentity) {
    const resolved = await this.resolveIdentity(identity);
    if (!resolved) return null;
    const { state } = await this.read();
    const key = identityKey({ ...identity, threadId: resolved.threadId });
    return state.entries.find((entry) => identityKey(entry) === key) ?? null;
  }

  async list() {
    return (await this.read()).state.entries;
  }

  async prepareCommitRemap(commits: ReadonlyMap<string, string>) {
    const { blob, state } = await this.readStored();
    if (!blob) return null;
    const entries = remapState(state, commits).entries;
    if (areDeeplyEqual(entries, state.entries)) return null;
    const nextBlob = await this.repository.writeBlob(`${JSON.stringify({ entries, version: 1 } satisfies GitArcRegistryState)}\n`);
    return { newValue: nextBlob, oldValue: blob, ref: REGISTRY_REF };
  }

  async prepareClaim(
    entry: Omit<GitArcRegistryEntry, "updatedAt">,
    options?: GitArcRegistryReplaceOptions,
  ): Promise<GitArcRegistryMutation> {
    const { blob, state: storedState } = await this.readStored();
    const resolvedInput = await this.resolveIdentity(entry);
    if (!resolvedInput) throw new Error("The Git arc owner identity is unavailable.");
    const canonicalEntry = { ...entry, threadId: resolvedInput.threadId };
    const key = identityKey(canonicalEntry);
    const state = remapState(storedState, options?.commitRemaps);
    const resolvedEntries = await this.resolveEntries(state.entries);
    const owned = resolvedEntries.filter(candidate => identityKey(candidate.resolved) === key);
    const current = owned[0]?.resolved ?? null;
    if (options?.expectedCheckpointCommit) {
      if (!current) throw new Error("This thread no longer owns an active Git arc.");
      if (current.checkpointCommit !== options.expectedCheckpointCommit) {
        throw new Error("This thread's active Git arc changed before the registry update completed.");
      }
    } else if (current) {
      if (current.checkpointCommit === canonicalEntry.checkpointCommit) {
        return { nextState: { entries: resolvedEntries.map(candidate => candidate.resolved), version: 1 }, updates: [] };
      }
      throw new Error("This thread already owns a different active Git arc.");
    }
    const collisions = findGitArcCollisions(
      resolvedEntries.map(candidate => candidate.resolved),
      canonicalEntry,
      getGitArcLiveClaimPaths(canonicalEntry),
    );
    if (collisions.length) throw new GitArcCollisionError(collisions);
    const proposalIds = canonicalEntry.proposalIds ?? (canonicalEntry.proposalId ? [canonicalEntry.proposalId] : []);
    const { reloadScopes: _inputReloadScopes, ...storedEntry } = canonicalEntry;
    const nextEntry: GitArcRegistryEntry = {
      ...storedEntry,
      phase: canonicalEntry.phase ?? "active",
      proposalId: proposalIds.at(-1) ?? null,
      proposalIds,
      retainedArc: canonicalEntry.retainedArc ?? null,
      updatedAt: new Date().toISOString(),
    };
    const ownedRaw = new Set(owned.map(candidate => candidate.raw));
    const entries = [...state.entries.filter(candidate => !ownedRaw.has(candidate)), nextEntry]
      .sort((left, right) => identityKey(left).localeCompare(identityKey(right)));
    const canonicalRows = new Map(resolvedEntries.map(candidate => [candidate.raw, candidate.resolved]));
    canonicalRows.set(nextEntry, nextEntry);
    const nextState = {
      entries: entries.flatMap(raw => canonicalRows.get(raw) ?? []),
      version: 1,
    } satisfies GitArcRegistryState;
    const nextBlob = await this.repository.writeBlob(`${JSON.stringify({ entries, version: 1 } satisfies GitArcRegistryState)}\n`);
    return await this.prepareMutation(nextState,
      { newValue: nextBlob, oldValue: blob ?? "0".repeat(40), ref: REGISTRY_REF },
      current, nextEntry, options?.claimLossSnapshot);
  }

  async prepareRelease(identity: GitArcIdentity, options?: GitArcRegistryReplaceOptions): Promise<GitArcRegistryMutation | null> {
    const { blob, state: storedState } = await this.readStored();
    const resolvedInput = await this.resolveIdentity(identity);
    if (!resolvedInput) return null;
    const key = identityKey({ ...identity, threadId: resolvedInput.threadId });
    const resolvedStoredEntries = await this.resolveEntries(storedState.entries);
    const current = resolvedStoredEntries.find(candidate => identityKey(candidate.resolved) === key)?.resolved ?? null;
    if (options?.expectedCheckpointCommit) {
      if (!current) throw new Error("This thread no longer owns an active Git arc.");
      if (current.checkpointCommit !== options.expectedCheckpointCommit) {
        throw new Error("This thread's active Git arc changed before the registry update completed.");
      }
    }
    if (!blob || !current) return null;
    const ownedRaw = new Set(
      resolvedStoredEntries.filter(candidate => identityKey(candidate.resolved) === key).map(candidate => candidate.raw),
    );
    const entries = remapState({
      entries: storedState.entries.filter(candidate => !ownedRaw.has(candidate)),
      version: 1,
    }, options?.commitRemaps).entries;
    const nextState = remapState({
      entries: resolvedStoredEntries.filter(candidate => !ownedRaw.has(candidate.raw)).map(candidate => candidate.resolved),
      version: 1,
    }, options?.commitRemaps);
    const nextBlob = await this.repository.writeBlob(`${JSON.stringify({ entries, version: 1 } satisfies GitArcRegistryState)}\n`);
    return await this.prepareMutation(nextState, { newValue: nextBlob, oldValue: blob, ref: REGISTRY_REF }, current, null);
  }

  async claim(entry: Omit<GitArcRegistryEntry, "updatedAt">) {
    const mutation = await this.prepareClaim(entry);
    if (mutation.updates.length) await this.repository.updateRefs(mutation.updates);
    const resolved = await this.resolveIdentity(entry);
    return mutation.nextState.entries.find(candidate => (
      resolved && identityKey(candidate) === identityKey({ ...entry, threadId: resolved.threadId })
    ))!;
  }

  async set(entry: Omit<GitArcRegistryEntry, "updatedAt">, expectedCheckpointCommit?: string) {
    const mutation = await this.prepareSet(entry, expectedCheckpointCommit);
    if (mutation.updates.length) await this.repository.updateRefs(mutation.updates);
    const resolved = await this.resolveIdentity(entry);
    return mutation.nextState.entries.find(candidate => (
      resolved && identityKey(candidate) === identityKey({ ...entry, threadId: resolved.threadId })
    ))!;
  }

  async prepareSet(entry: Omit<GitArcRegistryEntry, "updatedAt">, expectedCheckpointCommit?: string): Promise<GitArcRegistryMutation> {
    const { blob, state } = await this.readStored();
    const resolvedInput = await this.resolveIdentity(entry);
    if (!resolvedInput) throw new Error("The Git arc owner identity is unavailable.");
    const canonicalEntry = { ...entry, threadId: resolvedInput.threadId };
    const key = identityKey(canonicalEntry);
    const resolvedEntries = await this.resolveEntries(state.entries);
    const owned = resolvedEntries.filter(candidate => identityKey(candidate.resolved) === key);
    const current = owned[0]?.resolved ?? null;
    if (expectedCheckpointCommit && current?.checkpointCommit !== expectedCheckpointCommit) {
      throw new Error("This thread's current Git arc changed before the registry update completed.");
    }
    const proposalIds = canonicalEntry.proposalIds ?? (canonicalEntry.proposalId ? [canonicalEntry.proposalId] : []);
    const { reloadScopes: _inputReloadScopes, ...storedEntry } = canonicalEntry;
    const nextEntry: GitArcRegistryEntry = {
      ...storedEntry,
      claimedPaths: canonicalEntry.phase === "resolved" ? [] : canonicalEntry.claimedPaths,
      phase: canonicalEntry.phase ?? "active",
      proposalId: proposalIds.at(-1) ?? null,
      proposalIds,
      retainedArc: canonicalEntry.retainedArc ?? null,
      updatedAt: new Date().toISOString(),
    };
    const ownedRaw = new Set(owned.map(candidate => candidate.raw));
    const entries = [...state.entries.filter(candidate => !ownedRaw.has(candidate)), nextEntry]
      .sort((left, right) => identityKey(left).localeCompare(identityKey(right)));
    const nextBlob = await this.repository.writeBlob(`${JSON.stringify({ entries, version: 1 } satisfies GitArcRegistryState)}\n`);
    const canonicalRows = new Map(resolvedEntries.map(candidate => [candidate.raw, candidate.resolved]));
    canonicalRows.set(nextEntry, nextEntry);
    const nextState = {
      entries: entries.flatMap(raw => canonicalRows.get(raw) ?? []),
      version: 1,
    } satisfies GitArcRegistryState;
    return await this.prepareMutation(nextState,
      { newValue: nextBlob, oldValue: blob ?? "0".repeat(40), ref: REGISTRY_REF }, current, nextEntry);
  }

  async release(identity: GitArcIdentity) {
    const mutation = await this.prepareRelease(identity);
    if (mutation) await this.repository.updateRefs(mutation.updates);
  }
}
