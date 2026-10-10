/*
 * Exports:
 * - GitArcEditSessionMetadata: durable phase, operations and presentation facts of one edit session.
 * - GitArcEditSession: the thread's stored session with its base, moved-only and target trees.
 * - default GitArcEditSessionStore: read, prepare, publish and delete the thread's `edit-session` ref.
 */
import { z } from "zod";

import { GitArcEditFileSchema, GitArcEditOperationSchema } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import { normalizeThreadId } from "workbench-shared/workbench/git/git-arc-storage";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import { passthroughGitArcThreadIdentityResolver, type GitArcThreadIdentityResolver } from "./git-arc-thread-identity";
import type WorkbenchGitRepository from "./WorkbenchGitRepository";

const SESSION_KIND = "workbench-arc-edit-session";

const GitArcEditSessionMetadataSchema = z.object({
  additionalClaims: z.array(z.string().min(1)).default([]),
  files: z.array(GitArcEditFileSchema).default([]),
  ignoredPaths: z.array(z.string().min(1)).default([]),
  kind: z.literal(SESSION_KIND),
  matchedPreview: z.boolean().optional(),
  /** Repository-relative operations, replanned against the live worktree on apply. */
  operations: z.array(GitArcEditOperationSchema).default([]),
  phase: z.enum(["preview", "applied"]),
  rootId: z.string().min(1).optional(),
  skippedFileCount: z.number().int().nonnegative().default(0),
  touchedPaths: z.array(z.string().min(1)).default([]),
  version: z.literal(1),
  warnings: z.array(z.string()).default([]),
});
export type GitArcEditSessionMetadata = z.infer<typeof GitArcEditSessionMetadataSchema>;

const METADATA_DEFAULTS: z.input<typeof GitArcEditSessionMetadataSchema> = { kind: SESSION_KIND, phase: "preview", version: 1 };

export interface GitArcEditSession {
  base: string;
  commit: string;
  metadata: GitArcEditSessionMetadata;
  moved: string;
  session: string;
  target: string;
}

interface Identity { harness: string; threadId: string }

export default class GitArcEditSessionStore {
  constructor(
    private readonly repository: WorkbenchGitRepository,
    private readonly resolveThreadIdentity: GitArcThreadIdentityResolver = passthroughGitArcThreadIdentityResolver,
  ) {}

  private async ref(identity: Identity) {
    const resolved = await this.resolveThreadIdentity({ ...identity, repositoryRoot: this.repository.root });
    if (!resolved) throw new Error("The edit session owner identity is unavailable.");
    return `refs/worktree/agents/${identity.harness}/${normalizeThreadId(resolved.threadId)}/edit-session`;
  }

  async read(identity: Identity): Promise<GitArcEditSession | null> {
    const commit = await this.repository.readRef(await this.ref(identity));
    if (!commit) return null;
    const head = await this.repository.readCommit(commit);
    const movedCommit = head.parents[0];
    const movedIdentity = movedCommit ? await this.repository.readCommit(movedCommit) : null;
    const baseCommit = movedIdentity?.parents[0];
    const baseIdentity = baseCommit ? await this.repository.readCommit(baseCommit) : null;
    if (!movedIdentity || !baseIdentity) throw new Error("The stored edit session is incomplete. End it and start again.");
    let stored: unknown = null;
    try {
      stored = JSON.parse(head.message);
    } catch {
      // Unreadable metadata conforms to defaults below, which leaves no operations to apply.
    }
    const { data, repairedPaths } = conformToZodSchema(GitArcEditSessionMetadataSchema, stored, METADATA_DEFAULTS);
    if (repairedPaths.length) {
      console.warn(`[git-arc-edit] repaired stored edit session fields: ${repairedPaths.slice(0, 10).map(entry => entry.join(".") || "(root)").join(", ")}`);
    }
    return { base: baseIdentity.tree, commit, metadata: data, moved: movedIdentity.tree, session: commit.slice(0, 8), target: head.tree };
  }

  /** Write the session's objects without publishing them. */
  async prepare(trees: { base: string; moved: string; target: string }, metadata: GitArcEditSessionMetadata): Promise<GitArcEditSession> {
    const baseCommit = await this.repository.createCommitFromTree(trees.base, null, `${SESSION_KIND} base`);
    const movedCommit = await this.repository.createCommitFromTree(trees.moved, baseCommit, `${SESSION_KIND} moved`);
    const commit = await this.repository.createCommitFromTree(
      trees.target, movedCommit, JSON.stringify(GitArcEditSessionMetadataSchema.parse(metadata)),
    );
    return { base: trees.base, commit, metadata, moved: trees.moved, session: commit.slice(0, 8), target: trees.target };
  }

  /** Point the ref at a prepared session only while it still names `expectedCommit` (null when none may exist). */
  async publish(identity: Identity, session: GitArcEditSession, expectedCommit: string | null) {
    await this.repository.updateRef(await this.ref(identity), session.commit, expectedCommit ?? "0".repeat(40));
    return session;
  }

  async delete(identity: Identity, expectedCommit: string) {
    await this.repository.deleteRef(await this.ref(identity), expectedCommit);
  }
}
