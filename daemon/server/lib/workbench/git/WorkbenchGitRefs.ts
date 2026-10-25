/*
 * Exports:
 * - default WorkbenchGitRefs: one checkout's ref facts and object reads: branch position against its upstream and peers,
 *   marked HEAD history, local branches, stashes, commit and stash details with their file sides, and the checked-out
 *   branch's upstream target, non-interactive fetch and push.
 * - GitObjectSides: the base commit and changed tree one object's file diffs and previews compare.
 */
import type { GitBranchList, GitObjectDetail, GitObjectFile, GitObjectRef, GitStashList } from "workbench-shared/workbench/git/git-object-contracts";
import type { GitBranchPosition, GitPeerAddress } from "workbench-shared/workbench/git/git-peer-contracts";
import type { GitHistory, GitHistoryRequest, GitPushResult } from "workbench-shared/workbench/git/git-history-contracts";
import { listTreeFileChanges } from "./git-tree-file-changes";
import WorkbenchGitHistoryRewriter from "./WorkbenchGitHistoryRewriter";
import WorkbenchGitPeerTransport from "./WorkbenchGitPeerTransport";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
/** Git Credential Manager would otherwise open a sign-in window for a fetch nobody is watching. */
const FETCH_ENV = { ...GIT_ENV, GCM_INTERACTIVE: "never" };
const FIELD = "\u001f";

export interface GitObjectSides {
  /** The base commit; null compares against the empty tree. */
  head: string | null;
  tree: string;
}

export default class WorkbenchGitRefs {
  constructor(readonly repository: WorkbenchGitRepository) {}

  /** Reads Git directly instead of through memoised ref facts: other processes move refs a watch reports. */
  private async ref(name: string) {
    const output = await this.repository.run(["for-each-ref", "--format=%(refname) %(objectname)", name]);
    for (const line of output.split(/\r?\n/u)) {
      const [ref, objectId] = line.trim().split(" ");
      if (ref === name && objectId) return objectId;
    }
    return null;
  }

  async head() {
    try { return (await this.repository.run(["rev-parse", "-q", "--verify", "HEAD^{commit}"])).trim() || null; }
    catch { return null; }
  }

  async branch() {
    let branchRef: string | null = null;
    try { branchRef = (await this.repository.run(["symbolic-ref", "-q", "HEAD"])).trim() || null; }
    catch { branchRef = null; }
    return branchRef?.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : null;
  }

  /** `ahead`: commits `tip` lacks. `behind`: commits HEAD lacks; an unborn HEAD lacks all of `tip`. */
  private async counts(head: string | null, tip: string | null) {
    if (!tip || tip === head) return { ahead: 0, behind: 0 };
    if (!head) return { ahead: 0, behind: Number((await this.repository.run(["rev-list", "--count", tip])).trim()) };
    const [ahead, behind] = (await this.repository.run(["rev-list", "--left-right", "--count", `${head}...${tip}`]))
      .trim().split(/\s+/u).map(Number) as [number, number];
    return { ahead, behind };
  }

  /** The branch's configured upstream (`origin/main`) and its tip; null without one. */
  private async upstream(branch: string | null) {
    if (!branch) return null;
    let name: string;
    try { name = (await this.repository.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`])).trim(); }
    catch { return null; }
    if (!name) return null;
    const tip = await this.ref(`refs/remotes/${name}`);
    return tip ? { name, tip } : null;
  }

  async position(peers: readonly GitPeerAddress[]): Promise<GitBranchPosition> {
    const branch = await this.branch();
    const head = await this.head();
    const upstream = await this.upstream(branch);
    const counted = [];
    for (const peer of peers) {
      const tip = branch ? await this.ref(WorkbenchGitPeerTransport.trackingRef(peer, branch)) : null;
      counted.push({ daemonId: peer.daemonId, projectId: peer.projectId, tip, ...await this.counts(head, tip) });
    }
    return {
      branch, head, peers: counted,
      upstream: upstream ? { name: upstream.name, ...await this.counts(head, upstream.tip) } : null,
    };
  }

  /** Commits reachable from HEAD but not `tip`, within HEAD's newest `limit` commits. */
  private async missingFrom(tip: string, limit: number) {
    const output = await this.repository.run(["rev-list", `--max-count=${limit}`, "HEAD", "--not", tip, "--"]);
    return new Set(output.split(/\r?\n/u).filter(Boolean));
  }

  async history(request: GitHistoryRequest): Promise<GitHistory> {
    const branch = await this.branch();
    const head = await this.head();
    if (!head) return { branch, head, commits: [], complete: true };
    const output = await this.repository.run(["log", "--date-order", `--max-count=${request.limit + 1}`,
      `--format=%H${FIELD}%an${FIELD}%at${FIELD}%s`, "-z", "HEAD", "--"]);
    const records = output.split("\0").filter(Boolean);
    const upstream = await this.upstream(branch);
    const unpushed = upstream ? await this.missingFrom(upstream.tip, request.limit) : new Set<string>();
    const unsent = new Set<string>();
    for (const peer of branch ? request.peers : []) {
      const tip = await this.ref(WorkbenchGitPeerTransport.trackingRef(peer, branch!));
      if (tip) for (const commit of await this.missingFrom(tip, request.limit)) unsent.add(commit);
    }
    const commits = records.slice(0, request.limit).map(record => {
      const [commit = "", author = "", authoredAt = "0", ...subject] = record.replace(/^\r?\n/u, "").split(FIELD);
      return {
        commit, author, authoredAt: Number(authoredAt) * 1000, subject: subject.join(FIELD),
        unpushed: unpushed.has(commit), unsent: unsent.has(commit),
      };
    });
    return { branch, head, commits, complete: records.length <= request.limit };
  }

  /** Local branches, most recently committed first, with upstream counts and any other worktree holding them. */
  async branches(): Promise<GitBranchList> {
    const head = await this.head();
    const current = await this.branch();
    const output = await this.repository.run(["for-each-ref", "--sort=-committerdate",
      `--format=%(refname:short)${FIELD}%(objectname)${FIELD}%(committerdate:unix)${FIELD}%(upstream:short)${FIELD}%(worktreepath)`,
      "refs/heads"]);
    const root = this.repository.root.replace(/\\/gu, "/").toLowerCase();
    const branches: GitBranchList["branches"] = [];
    for (const line of output.split(/\r?\n/u).filter(Boolean)) {
      const [name = "", tip = "", committedAt = "0", upstreamName = "", worktree = ""] = line.split(FIELD);
      const upstreamTip = upstreamName ? await this.ref(`refs/remotes/${upstreamName}`) : null;
      const elsewhere = worktree && worktree.replace(/\\/gu, "/").toLowerCase() !== root ? worktree : null;
      branches.push({
        name, head: tip, committedAt: Number(committedAt) * 1000,
        upstream: upstreamName && upstreamTip ? { name: upstreamName, ...await this.counts(tip, upstreamTip) } : null,
        worktree: elsewhere,
      });
    }
    return { current, head, branches };
  }

  /** Every stash in the reflog, newest first, with the branch it was made on when Git recorded one. */
  private async allStashes() {
    if (!await this.ref("refs/stash")) return [];
    const output = await this.repository.run(["log", "-g", `--format=%H${FIELD}%ct${FIELD}%P${FIELD}%s${FIELD}%gs`, "-z", "refs/stash", "--"]);
    return output.split("\0").filter(Boolean).map((record, index) => {
      const [sha = "", createdAt = "0", parents = "", subject = "", ...reflog] = record.replace(/^\r?\n/u, "").split(FIELD);
      const text = reflog.join(FIELD).trim() || subject.trim();
      // Git writes `On <branch>: message` for named stashes and `WIP on <branch>: <sha> <subject>` for unnamed ones.
      const named = /^On ([^:]+): ([\s\S]*)$/u.exec(text);
      const unnamed = /^(?:WIP|index) on ([^:]+):/u.exec(text);
      const recorded = named?.[1] ?? unnamed?.[1];
      return {
        sha, index, createdAt: Number(createdAt) * 1000, base: parents.split(" ")[0] ?? "",
        /** Null for a detached HEAD; undefined when Git recorded no branch at all. */
        branch: recorded === undefined ? undefined : recorded === "(no branch)" ? null : recorded,
        message: named ? named[2]!.trim() : unnamed ? "" : text,
      };
    });
  }

  /**
   * The checked-out branch's stashes, newest first; `index` is each entry's `stash@{n}` position when read. A stash
   * Git recorded no branch for belongs to the branches whose history holds the commit it was made on.
   */
  async stashes(): Promise<GitStashList> {
    const branch = await this.branch();
    const head = await this.head();
    const stashes: GitStashList["stashes"] = [];
    for (const stash of await this.allStashes()) {
      const own = stash.branch !== undefined ? stash.branch === branch
        : Boolean(head && stash.base && await this.repository.isAncestor(stash.base, head));
      if (own) stashes.push({ sha: stash.sha, index: stash.index, createdAt: stash.createdAt, message: stash.message });
    }
    return { stashes };
  }

  /** The stash entry's current `stash@{n}` name, or null once it left the stash list. */
  async stashName(sha: string) {
    const entry = (await this.allStashes()).find(stash => stash.sha === sha);
    return entry ? `stash@{${entry.index}}` : null;
  }

  private async readMessage(commit: string) {
    const output = await this.repository.run(["show", "-s", `--format=%P${FIELD}%an${FIELD}%at${FIELD}%B`, commit, "--"]);
    const [parents = "", author = "", authoredAt = "0", ...message] = output.split(FIELD);
    const text = message.join(FIELD).trim();
    const [subject = "", ...body] = text.split(/\r?\n/u);
    return {
      parents: parents.trim().split(/\s+/u).filter(Boolean), author, authoredAt: Number(authoredAt) * 1000,
      subject, body: body.join("\n").trim(),
    };
  }

  /**
   * A commit compares against its first parent. A stash compares its saved worktree against the commit it was made on,
   * plus its untracked files (third parent) as additions.
   */
  async objectFiles(object: GitObjectRef): Promise<Array<{ file: GitObjectFile; sides: GitObjectSides }>> {
    const { parents } = await this.readMessage(object.sha);
    const base = parents[0] ?? null;
    const sides: GitObjectSides = { head: base, tree: await this.repository.resolveTree(object.sha) };
    const files = (await listTreeFileChanges(this.repository, await this.repository.resolveTree(base), sides.tree))
      .map(file => ({ file, sides }));
    const untracked = object.kind === "stash" ? parents[2] : undefined;
    if (untracked) {
      const untrackedSides = { head: null, tree: await this.repository.resolveTree(untracked) };
      for (const file of await listTreeFileChanges(this.repository, await this.repository.resolveTree(null), untrackedSides.tree)) {
        if (!files.some(entry => entry.file.path === file.path)) files.push({ file, sides: untrackedSides });
      }
    }
    return files;
  }

  async objectDetail(object: GitObjectRef): Promise<Omit<GitObjectDetail, "threads">> {
    const stash = object.kind === "stash" ? (await this.allStashes()).find(candidate => candidate.sha === object.sha) : undefined;
    if (object.kind === "stash" && !stash) throw new Error("This stash is gone.");
    const message = await this.readMessage(object.sha);
    const head = await this.head();
    let undoBlocked: string | null = "Only the latest commit can be undone.";
    if (object.kind === "stash") undoBlocked = "Stashes are restored, not undone.";
    else if (object.sha === head) {
      if (message.parents.length > 1) undoBlocked = "Merge commits cannot be undone here.";
      else {
        const amend = await new WorkbenchGitHistoryRewriter(this.repository).classifyAmendability(head, { refresh: false });
        undoBlocked = amend.status === "available" ? null : amend.reason;
      }
    }
    return {
      object, ...message,
      // A stash's own name; empty when Git named it for the commit it was made on.
      subject: stash ? stash.message : message.subject,
      body: stash ? "" : message.body,
      undoBlocked,
      files: (await this.objectFiles(object)).map(entry => entry.file),
    };
  }

  /** The checked-out branch's upstream with the remote and remote branch it is configured from; null without one. */
  async upstreamTarget() {
    const branch = await this.branch();
    const upstream = await this.upstream(branch);
    if (!branch || !upstream) return null;
    const config = async (key: string) => {
      try { return (await this.repository.run(["config", "--get", key])).trim(); }
      catch { return ""; }
    };
    const remote = await config(`branch.${branch}.remote`);
    const merge = await config(`branch.${branch}.merge`);
    return remote && remote !== "." && merge.startsWith("refs/heads/") ? { branch, ...upstream, remote, merge } : null;
  }

  /**
   * Fetches the checked-out branch's upstream remote without prompting, since background fetches have nobody to answer.
   * Returns false when the branch has no fetchable upstream.
   */
  async fetchUpstream(signal?: AbortSignal) {
    const target = await this.upstreamTarget();
    if (!target) return false;
    try {
      // No --prune: a remote-tracking ref is what marks its commits published, so a background fetch must not drop one.
      await this.repository.run(["fetch", "--quiet", target.remote], FETCH_ENV, signal);
    } catch {
      // Git stderr can echo remote URLs with embedded credentials, so only the remote name survives.
      throw new Error(`Could not fetch from ${target.remote}.`);
    } finally {
      WorkbenchGitRepository.forgetRefFacts(this.repository.root);
    }
    return true;
  }

  /** Pushes the checked-out branch to its upstream without force, so a diverged upstream rejects instead of losing work. */
  async push(signal?: AbortSignal): Promise<GitPushResult> {
    const branch = await this.branch();
    if (!branch) throw new Error("Pushing needs a checked-out branch.");
    const target = await this.upstreamTarget();
    if (!target) throw new Error(`Branch ${branch} has no upstream to push to.`);
    const { remote, merge, ...upstream } = target;
    const { ahead } = await this.counts(await this.head(), upstream.tip);
    try {
      await this.repository.run(["push", "--porcelain", remote, `refs/heads/${branch}:${merge}`], GIT_ENV, signal);
    } catch (error) {
      // Git stderr can echo remote URLs with embedded credentials, so only the rejection survives.
      const fields = error && typeof error === "object" ? error as { message?: unknown; stderr?: unknown; stdout?: unknown } : {};
      const text = [fields.message, fields.stderr, fields.stdout].filter(value => typeof value === "string").join("\n");
      throw new Error(/\[rejected\]|non-fast-forward|fetch first/u.test(text)
        ? `${upstream.name} has commits this branch lacks; pull them first.`
        : `Could not push to ${upstream.name}.`);
    } finally {
      WorkbenchGitRepository.forgetRefFacts(this.repository.root);
    }
    return { branch, upstream: upstream.name, pushed: ahead };
  }
}
