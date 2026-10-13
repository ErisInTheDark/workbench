/*
 * Exports:
 * - default WorkbenchGitPeerTransport: one checkout's side of a peer transfer: list held commits, stream a bundle of a
 *   branch's new commits, receive a bundle into the peer's tracking ref, read that ref, and measure the branch against peers.
 * - GitPeerMissingBranchError: the sender has no branch of the requested name.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { GitBranchPosition, GitPeerAddress } from "workbench-shared/workbench/git/git-peer-contracts";
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

  async position(peers: readonly GitPeerAddress[]): Promise<GitBranchPosition> {
    let branchRef: string | null = null;
    try { branchRef = (await this.repository.run(["symbolic-ref", "-q", "HEAD"])).trim() || null; }
    catch { branchRef = null; }
    const branch = branchRef?.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : null;
    const head = await this.head();
    const counted = [];
    for (const peer of peers) {
      const tip = branch ? await this.ref(WorkbenchGitPeerTransport.trackingRef(peer, branch)) : null;
      let ahead = 0;
      let behind = 0;
      if (tip && head && tip !== head) {
        [ahead, behind] = (await this.repository.run(["rev-list", "--left-right", "--count", `${head}...${tip}`]))
          .trim().split(/\s+/u).map(Number) as [number, number];
      } else if (tip && !head) {
        behind = Number((await this.repository.run(["rev-list", "--count", tip])).trim());
      }
      counted.push({ daemonId: peer.daemonId, projectId: peer.projectId, tip, ahead, behind });
    }
    return { branch, head, peers: counted };
  }
}
