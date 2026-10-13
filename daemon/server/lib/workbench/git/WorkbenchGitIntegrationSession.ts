/*
 * Exports:
 * - default WorkbenchGitIntegrationSession: one thread's resumable integration of incoming commits into the checked-out
 *   branch: replay or merge built in memory, conflicts resolved through gitignored scratch files, claim-aware worktree
 *   blockers, and one atomic apply that carries the caller's own dirty claimed files three-way.
 * - WorkbenchGitIntegrationSource: where the incoming commits came from.
 * - WorkbenchGitIntegrationClaim: one thread's live claimed paths.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import GitArcPathSet from "workbench-shared/workbench/git/GitArcPathSet";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import GitArcHistoryRewriter from "./GitArcHistoryRewriter";
import WorkbenchGitIntegration, { listDirtyPaths } from "./WorkbenchGitIntegration";
import WorkbenchGitRepository, { GIT_STATE_GENERATION_REF, type GitTreeFile } from "./WorkbenchGitRepository";

const execute = promisify(execFile);
const sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const SourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upstream"), ref: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("peer"), hostname: z.string(), rootPath: z.string() }).strict(),
]);
export type WorkbenchGitIntegrationSource = z.infer<typeof SourceSchema>;
const SessionSchema = z.object({
  version: z.literal(1),
  source: SourceSchema,
  mode: z.enum(["replay", "merge"]),
  carryOwn: z.boolean(),
  headRef: z.string().min(1),
  oldHead: sha,
  incoming: sha,
  base: sha,
  /** Replay: local first-parent commits, oldest first. Merge: empty. */
  local: z.array(sha),
  /** Replay: next local commit to rebuild. Merge: 0 until the merge commit exists. */
  step: z.number().int().nonnegative(),
  /** Parent the next rebuilt commit lands on. */
  parent: sha,
  /** Replay: original local commit to its rebuilt commit. */
  rewritten: z.record(z.string(), sha),
  pending: z.object({ tree: sha, conflicts: z.array(z.string()) }).strict().nullable(),
  newHead: sha.nullable(),
}).strict();
type Session = z.infer<typeof SessionSchema>;
const StoredSchema = z.object({ session: SessionSchema.nullable() }).strict();

export interface WorkbenchGitIntegrationClaim { threadId: string; paths: readonly string[] }

interface Blockers {
  carried: string[];
  own: string[];
  others: Array<{ path: string; threadIds: string[] }>;
  unclaimed: string[];
}

const MARKER = /^(?:<{7}|>{7})(?: |$)|^={7}$/mu;

function overlaps(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export default class WorkbenchGitIntegrationSession {
  private readonly scratchRoot: string;

  constructor(private readonly options: {
    repository: WorkbenchGitRepository;
    threadId: string;
    listClaims(): Promise<WorkbenchGitIntegrationClaim[]>;
  }) {
    this.scratchRoot = path.join(options.repository.root, ".workbench", "integrate", WorkbenchGitIntegrationSession.slug(options.threadId));
  }

  private static slug(threadId: string) {
    return threadId.replace(/[^\w.-]/gu, "_");
  }

  private get repository() { return this.options.repository; }

  private async sessionPath() {
    const gitDir = path.resolve(this.repository.root, (await this.repository.run(["rev-parse", "--git-dir"])).trim());
    return path.join(gitDir, "workbench-integrate", `${WorkbenchGitIntegrationSession.slug(this.options.threadId)}.json`);
  }

  private async read(): Promise<Session | null> {
    let text: string;
    try { text = await fs.readFile(await this.sessionPath(), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new Error("This thread's integration session is unreadable. Run `wb git integrate end` and start again."); }
    const conformed = conformToZodSchema(StoredSchema, value, { session: null });
    if (!conformed.data.session) throw new Error("This thread's integration session is unreadable. Run `wb git integrate end` and start again.");
    return conformed.data.session;
  }

  private async require() {
    const session = await this.read();
    if (!session) throw new Error("This thread has no integration in progress. Run `wb git integrate start --from <source>`.");
    return session;
  }

  private async write(session: Session) {
    const file = await this.sessionPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ session }));
    await fs.rename(temporary, file);
  }

  /** Builds the integration in memory up to its first conflict; the worktree, index and refs stay untouched. */
  async start(input: { incoming: string; source: WorkbenchGitIntegrationSource; mode: "replay" | "merge"; carryOwn: boolean }) {
    if (await this.read()) throw new Error("This thread already has an integration in progress. Run `wb git integrate view`, or `end` it first.");
    const repository = this.repository;
    const headRef = await repository.run(["symbolic-ref", "-q", "HEAD"]).then(value => value.trim(), () => "");
    if (!headRef.startsWith("refs/heads/")) throw new Error("Detached HEAD cannot integrate incoming commits.");
    const oldHead = await repository.currentHead();
    const incoming = await repository.resolveCommit(input.incoming);
    if (await repository.isAncestor(incoming, oldHead)) return `Already up to date: ${headRef.slice("refs/heads/".length)} contains ${incoming.slice(0, 12)}.`;
    let base: string;
    let local: string[] = [];
    if (input.mode === "replay") {
      const replayable = await new WorkbenchGitIntegration(repository).replayable(oldHead, incoming);
      if (replayable.kind === "blocked") {
        throw new Error(`${replayable.reason ?? "Local commits cannot be replayed."} Use \`--merge\` to keep them and add one merge commit instead.`);
      }
      base = replayable.base;
      local = replayable.commits.map(({ commit }) => commit);
    } else {
      base = (await repository.run(["merge-base", oldHead, incoming])).trim();
    }
    const session: Session = {
      version: 1, source: input.source, mode: input.mode, carryOwn: input.carryOwn, headRef, oldHead, incoming, base, local,
      step: 0, parent: input.mode === "replay" ? incoming : oldHead, rewritten: {}, pending: null,
      newHead: input.mode === "replay" && !local.length ? incoming : null,
    };
    await this.advance(session);
    return await this.view();
  }

  /** Rebuilds commits until one conflicts or all are done, saving progress either way. */
  private async advance(session: Session) {
    const repository = this.repository;
    if (session.mode === "merge") {
      if (!session.newHead && !session.pending) {
        const merged = await repository.mergeWorktreeTrees(session.base, session.oldHead, session.incoming);
        if (merged.conflictedPaths.length) await this.conflict(session, merged.tree, merged.conflictedPaths);
        else session.newHead = await this.mergeCommit(session, merged.tree);
      }
      await this.write(session);
      return;
    }
    const batch = await repository.readCommits(session.local);
    while (!session.pending && session.step < session.local.length) {
      const commit = session.local[session.step]!;
      const metadata = batch.commits.get(commit);
      if (!metadata) throw new Error(batch.errors.get(commit) ?? `Unable to read commit metadata for ${commit}.`);
      const merged = await repository.mergeWorktreeTrees(metadata.parents[0]!, session.parent, commit);
      if (merged.conflictedPaths.length) {
        await this.conflict(session, merged.tree, merged.conflictedPaths);
        break;
      }
      this.landCommit(session, commit, await repository.createCommitFromTree(merged.tree, session.parent, metadata.message, metadata));
    }
    if (!session.pending && session.step >= session.local.length) session.newHead = session.parent;
    await this.write(session);
  }

  private landCommit(session: Session, original: string, rebuilt: string) {
    session.rewritten[original] = rebuilt;
    session.parent = rebuilt;
    session.step++;
  }

  private async mergeCommit(session: Session, tree: string) {
    const label = session.source.kind === "upstream" ? session.source.ref : `${session.source.hostname}:${session.source.rootPath}`;
    return await this.repository.createCommitFromTree(tree, [session.oldHead, session.incoming],
      `merge ${session.headRef.slice("refs/heads/".length)} from ${label}`);
  }

  /** Writes each conflicted file, markers included, to scratch; a file the merged tree lacks is left absent. */
  private async conflict(session: Session, tree: string, conflicts: string[]) {
    await fs.rm(this.scratchRoot, { recursive: true, force: true });
    await this.scratchDirectory(this.scratchRoot);
    const files = await this.repository.readTreeFiles(tree, conflicts);
    for (const conflict of conflicts) {
      const file = files.get(conflict);
      if (!file) continue;
      const target = path.join(this.scratchRoot, ...conflict.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.bytes);
    }
    session.pending = { tree, conflicts };
  }

  /** Reads resolved scratch files back into the conflicted step, then continues building. */
  async resolve() {
    const session = await this.require();
    const pending = session.pending;
    if (!pending) throw new Error("Nothing to resolve. Run `wb git integrate view`.");
    const current = await this.repository.readTreeFiles(pending.tree, pending.conflicts);
    const files = new Map<string, GitTreeFile | null>();
    const marked: string[] = [];
    for (const conflict of pending.conflicts) {
      const target = path.join(this.scratchRoot, ...conflict.split("/"));
      const bytes = await fs.readFile(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (bytes && MARKER.test(bytes.toString("utf8"))) marked.push(conflict);
      files.set(conflict, bytes ? { bytes, mode: current.get(conflict)?.mode ?? "100644" } : null);
    }
    if (marked.length) throw new Error(`Conflict markers remain in:\n${marked.map(file => `  ${this.scratchPath(file)}`).join("\n")}`);
    const tree = await this.repository.writeTreeWithFiles(pending.tree, files);
    session.pending = null;
    await fs.rm(this.scratchRoot, { recursive: true, force: true });
    if (session.mode === "merge") session.newHead = await this.mergeCommit(session, tree);
    else {
      const commit = session.local[session.step]!;
      const metadata = (await this.repository.readCommits([commit])).commits.get(commit);
      if (!metadata) throw new Error(`Unable to read commit metadata for ${commit}.`);
      this.landCommit(session, commit, await this.repository.createCommitFromTree(tree, session.parent, metadata.message, metadata));
    }
    await this.advance(session);
    return await this.view();
  }

  /** Scratch lives under a self-ignoring folder, so no project needs an ignore rule for it. */
  private async scratchDirectory(directory: string) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(path.dirname(this.scratchRoot), ".gitignore"), "*\n");
  }

  private scratchPath(file: string) {
    return path.relative(this.repository.root, path.join(this.scratchRoot, ...file.split("/"))).replace(/\\/gu, "/");
  }

  /** Dirty paths the move from the old to the new HEAD would touch, grouped by who owns them. */
  private async blockers(session: Session): Promise<Blockers> {
    const target = session.newHead;
    if (!target) return { carried: [], own: [], others: [], unclaimed: [] };
    const changed = await this.repository.listAllChangedPaths(session.oldHead, target);
    const dirty = (await listDirtyPaths(this.repository)).filter(file => !file.startsWith(".workbench/integrate/")
      && changed.some(incoming => overlaps(file, incoming)));
    const claims = (await this.options.listClaims()).map(claim => ({ threadId: claim.threadId, paths: new GitArcPathSet([...claim.paths]) }));
    const blockers: Blockers = { carried: [], own: [], others: [], unclaimed: [] };
    for (const file of [...new Set(dirty)].sort()) {
      const owners = claims.filter(claim => claim.paths.overlaps(file)).map(claim => claim.threadId);
      if (owners.includes(this.options.threadId) && owners.length === 1) (session.carryOwn ? blockers.carried : blockers.own).push(file);
      else if (owners.length) blockers.others.push({ path: file, threadIds: owners.filter(owner => owner !== this.options.threadId) });
      else blockers.unclaimed.push(file);
    }
    return blockers;
  }

  async view() {
    const session = await this.require();
    const branch = session.headRef.slice("refs/heads/".length);
    const source = session.source.kind === "upstream" ? session.source.ref : `${session.source.hostname} (${session.source.rootPath})`;
    const lines = [`Integrating ${session.incoming.slice(0, 12)} from ${source} into ${branch} by ${
      session.mode === "merge" ? "merge commit" : session.local.length ? `replaying ${session.local.length} local commits` : "fast-forward"}.`];
    if (session.pending) {
      const step = session.mode === "replay" ? `local commit ${session.local[session.step]!.slice(0, 12)} (${session.step + 1}/${session.local.length})` : "the merge";
      lines.push(`Conflicts in ${step}. Edit these scratch files until no conflict markers remain (delete one to delete that file):`,
        ...session.pending.conflicts.map(file => `  ${this.scratchPath(file)}`), "Then run `wb git integrate resolve`.");
      return `${lines.join("\n")}\n`;
    }
    const blockers = await this.blockers(session);
    lines.push(`Ready: ${branch} moves ${session.oldHead.slice(0, 12)} -> ${session.newHead!.slice(0, 12)}.`);
    if (await this.repository.currentHead() !== session.oldHead) {
      lines.push(`${branch} moved since start; run \`wb git integrate end\`, then start again.`);
    }
    if (blockers.carried.length) lines.push("Your dirty claimed files, carried three-way on apply:", ...blockers.carried.map(file => `  ${file}`));
    if (blockers.own.length) lines.push("Your dirty claimed files block apply; commit them, or end and restart with --carry-own:",
      ...blockers.own.map(file => `  ${file}`));
    if (blockers.others.length) lines.push("Other threads' dirty claimed files block apply; `wb git integrate wait` waits for them:",
      ...blockers.others.map(({ path: file, threadIds }) => `  ${file} (${threadIds.join(", ")})`));
    if (blockers.unclaimed.length) lines.push("Unclaimed dirty files block apply; ask the user to commit, stash or discard them:",
      ...blockers.unclaimed.map(file => `  ${file}`));
    if (!blockers.own.length && !blockers.others.length && !blockers.unclaimed.length) lines.push("Run `wb git integrate apply`.");
    return `${lines.join("\n")}\n`;
  }

  /** One check for `wait`: blocked while other threads' claims still hold dirty incoming paths. */
  async waitAttempt(): Promise<{ kind: "blocked" } | { kind: "clear"; text: string }> {
    const session = await this.require();
    if (session.pending) throw new Error("Resolve the pending conflicts first; `wb git integrate view` lists them.");
    const blockers = await this.blockers(session);
    if (blockers.others.length) return { kind: "blocked" };
    return { kind: "clear", text: await this.view() };
  }

  /** Moves HEAD, index and worktree to the built result and remaps Workbench refs, all or nothing. */
  async apply() {
    const session = await this.require();
    const repository = this.repository;
    if (session.pending || !session.newHead) throw new Error("Resolve the pending conflicts first; `wb git integrate view` lists them.");
    if (await repository.currentHead() !== session.oldHead) {
      throw new Error("HEAD moved since this integration started. Run `wb git integrate end`, then start again.");
    }
    const blockers = await this.blockers(session);
    if (blockers.own.length || blockers.others.length || blockers.unclaimed.length) {
      throw new Error(`Dirty files block apply.\n${await this.view()}`);
    }
    const generation = await repository.readRef(GIT_STATE_GENERATION_REF);
    const rewritten = new Map(Object.entries(session.rewritten));
    const arcPlan = rewritten.size ? await new GitArcHistoryRewriter(repository).prepare(rewritten) : null;
    const carried = blockers.carried;
    const before = await repository.readTreeFiles(session.oldHead, carried);
    const captured = new Map<string, Buffer | null>();
    for (const file of carried) {
      captured.set(file, await fs.readFile(path.join(repository.root, ...file.split("/"))).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }));
    }
    const restoreCaptured = async () => {
      for (const [file, bytes] of captured) {
        const target = path.join(repository.root, ...file.split("/"));
        if (bytes) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, bytes);
        } else await fs.rm(target, { force: true });
      }
    };
    // Carried files return to the old HEAD so Git's checkout can move them; their edits come back three-way below.
    if (carried.length) {
      await repository.resetMixedPaths(session.oldHead, carried);
      const tracked = carried.filter(file => before.get(file));
      await repository.restorePaths(session.oldHead, tracked);
      for (const file of carried.filter(file => !before.get(file))) await fs.rm(path.join(repository.root, ...file.split("/")), { force: true });
      // Restored files keep stale index stat data, which read-tree treats as dirty until refreshed.
      await repository.clearOrphanedIndexLock();
      await repository.run(["update-index", "-q", "--refresh"]);
    }
    let applied: Awaited<ReturnType<WorkbenchGitIntegration["apply"]>>;
    try {
      applied = await new WorkbenchGitIntegration(repository).apply({
        ahead: session.local.length, behind: 0, incomingPaths: [],
        kind: session.mode === "merge" ? "merge" : session.local.length ? "replay" : "fastForward",
        headRef: session.headRef, oldHead: session.oldHead, newHead: session.newHead, generation, arcPlan,
      });
    } catch (error) {
      await restoreCaptured();
      throw error;
    }
    const conflicted = await this.carry(session.newHead, before, captured);
    await this.end();
    return [
      `Moved ${session.headRef.slice("refs/heads/".length)} ${applied.fromSha.slice(0, 12)} -> ${applied.toSha.slice(0, 12)}.`,
      ...rewritten.size ? [`Rewrote ${rewritten.size} local commits.`] : [],
      ...carried.length ? [`Carried ${carried.length} dirty files.`] : [],
      ...conflicted.length ? ["Carried files with conflict markers to resolve in place:", ...conflicted.map(file => `  ${file}`)] : [],
      ...applied.warnings.map(warning => `Warning: ${String(warning)}`),
      "",
    ].join("\n");
  }

  /** Three-way merges each carried file (old HEAD, new HEAD, captured edit) back into the worktree. */
  private async carry(newHead: string, before: ReadonlyMap<string, GitTreeFile | null>, captured: ReadonlyMap<string, Buffer | null>) {
    const after = await this.repository.readTreeFiles(newHead, [...captured.keys()]);
    const conflicted: string[] = [];
    const workspace = path.join(path.dirname(this.scratchRoot), `${path.basename(this.scratchRoot)}-carry`);
    await this.scratchDirectory(workspace);
    try {
      for (const [file, edit] of captured) {
        const target = path.join(this.repository.root, ...file.split("/"));
        if (!edit) {
          // A local deletion of a file the incoming commits changed keeps their version for the caller to decide.
          if (after.get(file)) conflicted.push(file);
          continue;
        }
        const theirs = after.get(file)?.bytes ?? Buffer.alloc(0);
        const base = before.get(file)?.bytes ?? Buffer.alloc(0);
        const paths = ["current", "base", "incoming"].map(name => path.join(workspace, name));
        await Promise.all([fs.writeFile(paths[0]!, edit), fs.writeFile(paths[1]!, base), fs.writeFile(paths[2]!, theirs)]);
        const merged = await execute("git", ["merge-file", "-p", "-L", "yours", "-L", "before", "-L", "incoming", ...paths], {
          cwd: this.repository.root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        }).then(result => ({ bytes: result.stdout, conflicts: 0 }), (error: { code?: number; stdout?: Buffer }) => {
          // merge-file exits with its conflict count; larger codes are real failures.
          if (typeof error.code === "number" && error.code > 0 && error.code < 128 && error.stdout) return { bytes: error.stdout, conflicts: error.code };
          throw error;
        });
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, merged.bytes);
        if (merged.conflicts) conflicted.push(file);
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
    return conflicted;
  }

  async end() {
    await fs.rm(await this.sessionPath(), { force: true });
    await fs.rm(this.scratchRoot, { recursive: true, force: true });
    return "Integration session ended.\n";
  }
}
