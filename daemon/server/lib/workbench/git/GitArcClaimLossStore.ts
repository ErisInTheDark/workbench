/*
 * Exports:
 * - default GitArcClaimLossStore: own frozen claim-loss snapshots and guarded adopted-stash ref moves.
 */
import { GitArcClaimLossSchema, type GitArcClaimLoss } from "workbench-shared/workbench/git/git-arc-status";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { normalizeThreadId } from "workbench-shared/workbench/git/git-arc-storage";
import WorkbenchGitRepository, { type GitRefUpdate, type GitWorktreeSnapshot } from "./WorkbenchGitRepository";
import type { GitArcRegistryEntry } from "./GitArcRegistry";
import {
  gitArcThreadStorageIds,
  passthroughGitArcThreadIdentityResolver,
  type GitArcThreadIdentityResolver,
} from "./git-arc-thread-identity";

interface Identity { harness: string; threadId: string }

export default class GitArcClaimLossStore {
  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  private ref(identity: Identity) {
    if (!ProviderKeySchema.safeParse(identity.harness).success) throw new Error("Invalid claim-loss harness.");
    return `refs/worktree/agents/${identity.harness}/${normalizeThreadId(identity.threadId)}/claim-loss`;
  }

  private adoptedRef(identity: Identity) {
    if (!ProviderKeySchema.safeParse(identity.harness).success) throw new Error("Invalid saved-stash harness.");
    return `refs/worktree/agents/${identity.harness}/${normalizeThreadId(identity.threadId)}/arc-stash`;
  }

  private async identity(identity: Identity) {
    const resolved = await this.resolveThreadIdentity({
      harness: identity.harness,
      repositoryRoot: this.repository.root,
      threadId: identity.threadId,
    });
    if (!resolved) throw new Error("The Git arc owner identity is unavailable.");
    return resolved;
  }

  async prepare(
    identity: Identity,
    paths: string[],
    snapshot?: GitWorktreeSnapshot,
    options: { frozen?: boolean } = {},
  ): Promise<GitRefUpdate> {
    const boundary = snapshot ?? await this.repository.writeWorktreeSnapshot();
    const metadata: GitArcClaimLoss = GitArcClaimLossSchema.parse({
      version: 1,
      paths,
      head: boundary.head,
      frozen: options.frozen ?? false,
    });
    const commit = await this.repository.createCommitFromTree(boundary.tree, boundary.head, JSON.stringify(metadata));
    const ref = this.ref({ ...identity, threadId: (await this.identity(identity)).threadId });
    return { newValue: commit, oldValue: await this.repository.readRef(ref) ?? "0".repeat(40), ref };
  }

  async read(identity: Identity) {
    const refs = gitArcThreadStorageIds(await this.identity(identity))
      .map(threadId => this.ref({ ...identity, threadId }));
    let selected: { commit: string; ref: string } | null = null;
    for (const ref of refs) {
      const commit = await this.repository.readRef(ref);
      if (commit) {
        selected = { commit, ref };
        break;
      }
    }
    if (!selected) return null;
    return await this.readSnapshotRef(selected.ref, selected.commit);
  }

  private async readSnapshotRef(ref: string, commit: string) {
    const batch = await this.repository.readCommits([commit]);
    const stored = batch.commits.get(commit);
    if (!stored) throw new Error("The claim-loss snapshot is unreadable.");
    const metadata = GitArcClaimLossSchema.parse(JSON.parse(stored.message));
    if ((stored.parents[0] ?? null) !== metadata.head || stored.parents.length > 1) throw new Error("Invalid claim-loss snapshot parent.");
    return { ...metadata, commit, ref, tree: stored.tree };
  }

  async readAdopted(identity: Identity) {
    const resolved = await this.identity(identity);
    const ref = this.adoptedRef({ ...identity, threadId: resolved.threadId });
    const commit = await this.repository.readRef(ref);
    if (!commit) return null;
    const snapshot = await this.readSnapshotRef(ref, commit);
    if (!snapshot.frozen) throw new Error("The adopted stash snapshot is not frozen.");
    return snapshot;
  }

  private async prepareAdoptedAddress(snapshot: NonNullable<Awaited<ReturnType<GitArcClaimLossStore["read"]>>>, destination: Identity, deletions: Array<{ oldValue: string; ref: string }>) {
    const resolved = await this.identity(destination);
    const ref = this.adoptedRef({ ...destination, threadId: resolved.threadId });
    if (await this.repository.readRef(ref)) throw new Error("The caller's saved-stash address is already occupied.");
    return {
      snapshot,
      updates: [{ ref, oldValue: "0".repeat(40), newValue: snapshot.commit }] satisfies GitRefUpdate[],
      deletions,
    };
  }

  async prepareRehomeFrozen(source: Identity, destination: Identity, expectedPaths: readonly string[]) {
    const snapshot = await this.read(source);
    if (!snapshot?.frozen || snapshot.paths.length !== expectedPaths.length
      || snapshot.paths.some((value, index) => value !== expectedPaths[index])) {
      throw new Error("The source frozen stash snapshot does not match its claim set.");
    }
    const { deletions } = await this.prepareDeleteFrozen(source, expectedPaths);
    return await this.prepareAdoptedAddress(snapshot, destination, deletions);
  }

  async prepareRehomeAdopted(source: Identity, destination: Identity, expectedPaths: readonly string[]) {
    const snapshot = await this.readAdopted(source);
    if (!snapshot || snapshot.paths.length !== expectedPaths.length
      || snapshot.paths.some((value, index) => value !== expectedPaths[index])) {
      throw new Error("The source adopted stash snapshot does not match its claim set.");
    }
    return await this.prepareAdoptedAddress(snapshot, destination, [{ ref: snapshot.ref, oldValue: snapshot.commit }]);
  }

  async prepareDeleteAdopted(identity: Identity, expectedPaths: readonly string[]) {
    const snapshot = await this.readAdopted(identity);
    if (!snapshot || snapshot.paths.length !== expectedPaths.length
      || snapshot.paths.some((value, index) => value !== expectedPaths[index])) {
      throw new Error("The adopted stash snapshot does not match its registered paths.");
    }
    return [{ ref: snapshot.ref, oldValue: snapshot.commit }];
  }

  async readOwnedStash(identity: Identity, entry: GitArcRegistryEntry | null) {
    if (!entry) return null;
    if (entry.savedStash) {
      const snapshot = await this.readAdopted(identity);
      const saved = entry.savedStash;
      if (!snapshot || snapshot.paths.length !== saved.paths.length
        || snapshot.paths.some((value, index) => value !== saved.paths[index])) {
        throw new Error("The adopted stash snapshot does not match its registered paths.");
      }
      return {
        ...snapshot, checkpointCommit: saved.checkpointCommit,
        intentName: saved.intentName, intentDescription: saved.intentDescription,
        proposalIds: saved.proposalIds, legacy: false,
      };
    }
    if (entry.phase !== "stashed" || !entry.claimedPaths.length) return null;
    const snapshot = await this.read(identity);
    if (!snapshot?.frozen || snapshot.paths.length !== entry.claimedPaths.length
      || snapshot.paths.some((value, index) => value !== entry.claimedPaths[index])) {
      throw new Error("The ordinary stash snapshot does not match its registered paths.");
    }
    const arc = entry.retainedArc ?? entry;
    return {
      ...snapshot, checkpointCommit: arc.checkpointCommit,
      intentName: arc.intentName, intentDescription: arc.intentDescription,
      proposalIds: arc.proposalIds ?? [], legacy: true,
    };
  }

  async prepareDeleteFrozen(identity: Identity, expectedPaths: readonly string[]) {
    const snapshot = await this.read(identity);
    if (!snapshot?.frozen || snapshot.paths.length !== expectedPaths.length
      || snapshot.paths.some((path, index) => path !== expectedPaths[index])) {
      throw new Error("The frozen Git arc stash snapshot does not match its saved paths.");
    }
    const refs = gitArcThreadStorageIds(await this.identity(identity))
      .map(threadId => this.ref({ ...identity, threadId }));
    const deletions = (await Promise.all(refs.map(async ref => ({
      ref, value: await this.repository.readRef(ref),
    })))).flatMap(({ ref, value }) => value === snapshot.commit ? [{ oldValue: value, ref }] : []);
    return { deletions };
  }
}
