/*
 * Exports:
 * - default WorkbenchGitPeerTransport: one checkout's side of a peer transfer: list held commits, stream a bundle of a
 *   branch's new commits, receive a bundle into the peer's tracking ref, read directional upstream and peer counts, commit
 *   previews and marked HEAD history, and push the branch to its upstream.
 * - GitPeerMissingBranchError: the sender has no branch of the requested name.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { GitBranchPosition, GitPeerAddress, GitPeerCommits, GitPeerCommitsRequest } from "workbench-shared/workbench/git/git-peer-contracts";
import type { GitHistory, GitHistoryRequest, GitPushResult } from "workbench-shared/workbench/git/git-history-contracts";
import WorkbenchGitRepository from "./WorkbenchGitRepository";

export class GitPeerMissingBranchError extends Error {}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

function stderrText(chunks: readonly Buffer[]) {
  return Buffer.concat(chunks).toString("utf8").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 512);
}

export default class WorkbenchGitPeerTransport {
  constructor(private readonly repository: WorkbenchGitRepository) {}

  /** Peer refs live under one remote per peer folder, so two folders on one daemon never share a tracking ref. */
  static trackingRef(peer: GitPeerAddress, branch: string) {
    const folder = createHash("sha256").update(peer.projectId).digest("hex").slice(0, 8);
    return `refs/remotes/wb-${peer.daemonId}-${folder}/${branch}`;
  }

  /** Reads Git directly instead of through memoised ref facts: other processes move refs a watch reports. */
  private async ref(name: string) {
    const output = await this.repository.run(["for-each-ref", "--format=%(refname) %(objectname)", name]);
    for (const line of output.split(/\r?\n/u)) {
      const [ref, objectId] = line.trim().split(" ");
      if (ref === name && objectId) return objectId;
    }
    return null;
  }

  async trackingTip(peer: GitPeerAddress, branch: string) {
    return await this.ref(WorkbenchGitPeerTransport.trackingRef(peer, branch));
  }

  private async hasCommit(commit: string) {
    return await this.repository.succeeds(["cat-file", "-e", `${commit}^{commit}`]);
  }

  private async validBranch(branch: string) {
    if (!await this.repository.succeeds(["check-ref-format", `refs/heads/${branch}`])) throw new Error("Invalid branch name.");
  }

  async haves(peer: GitPeerAddress, branch: string) {
    await this.validBranch(branch);
    const head = await this.head();
    const candidates = [await this.ref(WorkbenchGitPeerTransport.trackingRef(peer, branch)),
      await this.ref(`refs/heads/${branch}`), head];
    return [...new Set(candidates.filter((commit): commit is string => commit !== null))];
  }

  /**
   * Opens a bundle of `branch` without commits the receiver holds. `bundle` is null when the receiver already holds the
   * tip; otherwise the caller must consume or destroy it, and `done` settles with Git's exit.
   */
  async bundle(branch: string, haves: readonly string[], signal: AbortSignal) {
    await this.validBranch(branch);
    const tip = await this.ref(`refs/heads/${branch}`);
    if (!tip) throw new GitPeerMissingBranchError(`This folder has no branch ${branch}.`);
    const known: string[] = [];
    for (const commit of haves) if (await this.hasCommit(commit)) known.push(commit);
    const fresh = Number((await this.repository.run(["rev-list", "--count", tip, ...known.length ? ["--not", ...known] : []])).trim());
    if (!fresh) return { tip, bundle: null, done: Promise.resolve() };
    const child = spawn("git", ["bundle", "create", "--quiet", "-", `refs/heads/${branch}`, ...known.length ? ["--not", ...known] : []], {
      cwd: this.repository.root, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal,
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 16) stderr.push(chunk); });
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve()
        : reject(new Error(`git bundle create failed${stderr.length ? `: ${stderrText(stderr)}` : ` with exit ${code}`}.`)));
    });
    return { tip, bundle: child.stdout, done };
  }

  /**
   * Fetches a streamed bundle into the peer's tracking ref; a null body records a tip this checkout already holds.
   * Only that tracking ref moves: HEAD, branches, the index and the worktree stay untouched.
   */
  async receive(peer: GitPeerAddress, branch: string, tip: string, body: Readable | null, signal: AbortSignal) {
    await this.validBranch(branch);
    const ref = WorkbenchGitPeerTransport.trackingRef(peer, branch);
    try {
      if (!body) {
        if (!await this.hasCommit(tip)) throw new Error("The peer's branch tip is not held here and no bundle was sent.");
        await this.repository.run(["update-ref", ref, tip]);
        return tip;
      }
      const commonDir = path.resolve(this.repository.root, (await this.repository.run(["rev-parse", "--git-common-dir"])).trim());
      const spoolDirectory = path.join(commonDir, "workbench-peer");
      await fs.promises.mkdir(spoolDirectory, { recursive: true });
      const spool = path.join(spoolDirectory, `${randomUUID()}.bundle`);
      try {
        await pipeline(body, fs.createWriteStream(spool), { signal });
        await this.repository.run(["bundle", "verify", "--quiet", spool], GIT_ENV, signal);
        await this.repository.run(["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--quiet", "--no-tags",
          "--no-write-fetch-head", spool, `+refs/heads/${branch}:${ref}`], GIT_ENV, signal);
      } finally {
        await fs.promises.rm(spool, { force: true });
      }
      const received = await this.ref(ref);
      if (received !== tip) throw new Error("The received bundle does not carry the announced branch tip.");
      return tip;
    } finally {
      WorkbenchGitRepository.forgetRefFacts(this.repository.root);
    }
  }

  private async head() {
    try { return (await this.repository.run(["rev-parse", "-q", "--verify", "HEAD^{commit}"])).trim() || null; }
    catch { return null; }
  }

  async commits(request: GitPeerCommitsRequest): Promise<GitPeerCommits> {
    await this.validBranch(request.branch);
    const branch = (await this.repository.run(["symbolic-ref", "-q", "HEAD"])).trim();
    if (branch !== `refs/heads/${request.branch}`) throw new Error("The selected branch changed.");
    const head = await this.head();
    const tip = await this.trackingTip(request.peer, request.branch);
    if (!tip) throw new Error("The peer's branch has not been fetched yet.");
    const include = request.action === "pull" ? tip : head;
    const exclude = request.action === "pull" ? head : tip;
    if (!include) return { branch: request.branch, head, tip, total: 0, commits: [] };
    const range = [include, ...exclude ? ["--not", exclude] : [], "--"];
    const total = Number((await this.repository.run(["rev-list", "--count", ...range])).trim());
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("Invalid peer commit count.");
    const output = await this.repository.run(["log", "--date-order", "--format=%H%x00%s", "-z",
      ...request.all ? [] : ["-3"], ...range]);
    const fields = output.split("\0");
    const commits: GitPeerCommits["commits"] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      commits.push({ commit: fields[index]!, subject: fields[index + 1]! });
    }
    return { branch: request.branch, head, tip, total, commits };
  }

  private async branch() {
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
      "--format=%H%x1f%an%x1f%at%x1f%s", "-z", "HEAD", "--"]);
    const records = output.split("\0").filter(Boolean);
    const upstream = await this.upstream(branch);
    const unpushed = upstream ? await this.missingFrom(upstream.tip, request.limit) : new Set<string>();
    const unsent = new Set<string>();
    for (const peer of branch ? request.peers : []) {
      const tip = await this.ref(WorkbenchGitPeerTransport.trackingRef(peer, branch!));
      if (tip) for (const commit of await this.missingFrom(tip, request.limit)) unsent.add(commit);
    }
    const commits = records.slice(0, request.limit).map(record => {
      const [commit = "", author = "", authoredAt = "0", ...subject] = record.replace(/^\r?\n/u, "").split("\u001f");
      return {
        commit, author, authoredAt: Number(authoredAt) * 1000, subject: subject.join("\u001f"),
        unpushed: unpushed.has(commit), unsent: unsent.has(commit),
      };
    });
    return { branch, head, commits, complete: records.length <= request.limit };
  }

  /** Pushes the checked-out branch to its upstream without force, so a diverged upstream rejects instead of losing work. */
  async push(signal?: AbortSignal): Promise<GitPushResult> {
    const branch = await this.branch();
    if (!branch) throw new Error("Pushing needs a checked-out branch.");
    const upstream = await this.upstream(branch);
    if (!upstream) throw new Error(`Branch ${branch} has no upstream to push to.`);
    const remote = (await this.repository.run(["config", "--get", `branch.${branch}.remote`])).trim();
    const merge = (await this.repository.run(["config", "--get", `branch.${branch}.merge`])).trim();
    if (!remote || !merge.startsWith("refs/heads/")) throw new Error(`Branch ${branch} has no pushable upstream.`);
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
