/*
 * Exports:
 * - default WorkbenchWorkingTreeRepository: own snapshot-bound selection, previews and Git mutations.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkingTreeDiff, WorkingTreeFile, WorkingTreeMutation, WorkingTreePreview,
  WorkingTreeRepository, WorkingTreeResult,
} from "workbench-shared/workbench/git/working-tree-contracts";
import { buildSelectedContent, describeWorkingTreeDiff } from "workbench-shared/workbench/git/working-tree-selection";
import WorkbenchGitRepository from "./WorkbenchGitRepository";
import WorkbenchGitHistoryRewriter from "./WorkbenchGitHistoryRewriter";

const TEXT_LIMIT = 1_000_000;
const IMAGE_LIMIT = 4_000_000;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
};
const zeroToNull = (value: string) => /^0+$/u.test(value) ? null : value;

export default class WorkbenchWorkingTreeRepository {
  constructor(readonly git: WorkbenchGitRepository) {}

  async read(): Promise<WorkingTreeRepository> {
    const { head, tree } = await this.git.writeWorktreeSnapshot();
    const base = await this.git.resolveTree(head);
    const raw = (await this.git.run(["diff", "--raw", "--no-abbrev", "-z", "-M", base, tree])).split("\0");
    const counts = (await this.git.run(["diff", "--numstat", "-z", "-M", base, tree])).split("\0");
    const stats = new Map<string, { additions: number | null; deletions: number | null }>();
    for (let i = 0; i < counts.length && counts[i]; i++) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(counts[i]!);
      if (!match) throw new Error("Invalid Git change counts.");
      let name = match[3]!;
      if (!name) { i++; name = counts[++i]!; }
      stats.set(name, {
        additions: match[1] === "-" ? null : Number(match[1]),
        deletions: match[2] === "-" ? null : Number(match[2]),
      });
    }
    const files: WorkingTreeFile[] = [];
    for (let i = 0; i < raw.length && raw[i]; i++) {
      const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([AMDRT])\d*$/u.exec(raw[i]!);
      if (!match) throw new Error("Unsupported Git change metadata.");
      const oldName = raw[++i]!;
      const status = match[5] as WorkingTreeFile["status"];
      const name = status === "R" ? raw[++i]! : oldName;
      const count = stats.get(name);
      if (!count) throw new Error("Git change counts are missing.");
      const baseBlob = zeroToNull(match[3]!);
      const blob = zeroToNull(match[4]!);
      const baseMode = match[1]!;
      const mode = match[2]!;
      const binary = count.additions === null;
      files.push({
        path: name, oldPath: status === "R" ? oldName : null, status,
        baseBlob, blob, baseMode, mode, ...count, binary,
        identity: `${oldName}\0${name}\0${baseMode}:${baseBlob}:${mode}:${blob}`,
        partial: status === "M" && baseMode === mode && mode.startsWith("100") && !binary,
        ownerIds: [],
      });
    }
    const branchRef = await this.git.symbolicHead();
    const amend = head ? await new WorkbenchGitHistoryRewriter(this.git).classifyAmendability(head, { refresh: false }) : null;
    return {
      rootId: "", label: path.basename(this.git.root), cwd: this.git.root,
      head, tree, branch: branchRef?.replace(/^refs\/heads\//u, "") ?? null,
      message: head ? await this.git.readCommitMessage(head) : "",
      amendReason: amend?.status === "available" ? null : amend?.reason ?? "There is no commit to amend.",
      blockedReason: await this.blockedReason(), files, owners: [],
    };
  }

  private async blockedReason() {
    if ((await this.git.run(["ls-files", "--unmerged", "-z"])).length) return "Resolve index conflicts before changing Git history.";
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
      const location = (await this.git.run(["rev-parse", "--git-path", name])).trim();
      try {
        await fs.stat(path.resolve(this.git.root, location));
        return "Finish the current merge, rebase or sequencer operation first.";
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return null;
  }

  private async blobSize(blob: string | null) {
    return blob ? Number((await this.git.run(["cat-file", "-s", blob])).trim()) : 0;
  }

  private async text(blob: string | null) {
    if (!blob) return "";
    const bytes = await this.git.runBufferWithInput(["cat-file", "blob", blob], "");
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error("File is not UTF-8 text. Use whole-file selection."); }
  }

  async diff(snapshot: WorkingTreeRepository, file: WorkingTreeFile): Promise<WorkingTreeDiff> {
    if (file.binary || file.mode === "160000" || file.baseMode === "160000") {
      return { identity: file.identity, patch: "", unavailable: "Binary or submodule change. Whole-file selection is available." };
    }
    const tooBig = Math.max(await this.blobSize(file.baseBlob), await this.blobSize(file.blob)) > TEXT_LIMIT;
    if (tooBig) {
      return { identity: file.identity, patch: "", unavailable: "Diff too large to display. Whole-file selection is available." };
    }
    const base = await this.git.resolveTree(snapshot.head);
    const patch = await this.git.run([
      "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", "--unified=3", base, snapshot.tree,
      "--", ...[file.path, ...(file.oldPath ? [file.oldPath] : [])].map(p => this.git.literalPathspec(p)),
    ]);
    return { identity: file.identity, patch, unavailable: null };
  }

  async preview(file: WorkingTreeFile): Promise<WorkingTreePreview> {
    const mime = IMAGE_TYPES[path.extname(file.path).toLowerCase()] ?? "text/plain";
    const encoding = mime.startsWith("image/") ? "base64" : "text";
    const limit = encoding === "base64" ? IMAGE_LIMIT : TEXT_LIMIT;
    const result: WorkingTreePreview = { identity: file.identity, before: null, after: null, encoding, mime, unavailable: null };
    if (file.mode === "160000" || file.baseMode === "160000"
      || Math.max(await this.blobSize(file.baseBlob), await this.blobSize(file.blob)) > limit
      || (file.binary && encoding === "text")) return { ...result, unavailable: "This file cannot be previewed." };
    const read = async (blob: string | null) => !blob ? null : encoding === "text"
      ? await this.text(blob) : (await this.git.runBufferWithInput(["cat-file", "blob", blob], "")).toString("base64");
    return { ...result, before: await read(file.baseBlob), after: await read(file.blob) };
  }

  private async selectedTree(snapshot: WorkingTreeRepository, request: WorkingTreeMutation, remaining = false) {
    const base = await this.git.resolveTree(snapshot.head);
    return await this.git.withTemporaryIndex(async index => {
      const env = { ...process.env, GIT_INDEX_FILE: index };
      await this.git.run(["read-tree", remaining ? snapshot.tree : base], env);
      for (const selection of request.selections) {
        const file = snapshot.files.find(file => file.path === selection.path);
        if (!file || file.identity !== selection.identity) throw new Error("Selected file changed. Refresh and select it again.");
        if (file.ownerIds.length) throw new Error("Claimed files are inspect-only.");
        let blob = remaining ? file.baseBlob : file.blob;
        let mode = remaining ? file.baseMode : file.mode;
        if (selection.lineIds !== null) {
          if (!file.partial) throw new Error("This file only supports whole-file selection.");
          const diff = await this.diff(snapshot, file);
          if (diff.unavailable) throw new Error(diff.unavailable);
          const ids = remaining
            ? describeWorkingTreeDiff(diff.patch).rows.filter(row => row.selectable && !selection.lineIds!.includes(row.id)).map(row => row.id)
            : selection.lineIds;
          const content = buildSelectedContent(await this.text(file.baseBlob), diff.patch, ids, await this.text(file.blob));
          blob = await this.git.writeBlob(content);
          mode = file.mode;
        }
        const destination = remaining && file.oldPath ? file.oldPath : file.path;
        const removed = remaining ? file.path : file.oldPath;
        if (removed && removed !== destination) await this.git.run(["update-index", "--force-remove", "--", removed], env);
        if (!blob) await this.git.run(["update-index", "--force-remove", "--", destination], env);
        else await this.git.run(["update-index", "--add", "--cacheinfo", mode, blob, destination], env);
      }
      return (await this.git.run(["write-tree"], env)).trim();
    });
  }

  async mutate(snapshot: WorkingTreeRepository, request: WorkingTreeMutation, verifyClaims: () => Promise<void>): Promise<WorkingTreeResult> {
    const reason = await this.blockedReason();
    if (reason) throw new Error(reason);
    if (snapshot.head !== request.expectedHead || await this.git.headOrNull() !== request.expectedHead) throw new Error("HEAD changed. Refresh before submitting.");
    const paths = [...new Set(request.selections.flatMap(selection => {
      const file = snapshot.files.find(file => file.path === selection.path);
      if (!file || file.identity !== selection.identity) throw new Error("Selected content is stale.");
      return [file.path, ...(file.oldPath ? [file.oldPath] : [])];
    }))];
    if (new Set(request.selections.map(selection => selection.path)).size !== request.selections.length) throw new Error("Duplicate file selections are invalid.");
    const message = [request.title.trim(), request.description.trim()].filter(Boolean).join("\n\n");
    if ((request.mode === "commit" || request.mode === "amend") && !request.title.trim()) throw new Error("A commit title is required.");
    if (!paths.length && request.mode !== "amend") throw new Error("Select changes first.");
    if (request.mode === "amend" && (!request.targetCommit || request.targetCommit !== snapshot.head)) throw new Error("The amend target changed.");
    if ((request.mode === "amend" || request.mode === "stash") && !snapshot.head) throw new Error("This operation requires an existing commit.");
    const tree = await this.selectedTree(snapshot, request);
    const base = await this.git.resolveTree(snapshot.head);
    if (paths.length && !(await this.git.listAllChangedPaths(base, tree)).length) throw new Error("The selection contains no changes.");
    const verify = async () => {
      await verifyClaims();
      if (await this.git.headOrNull() !== snapshot.head) throw new Error("HEAD changed while preparing the operation.");
      const live = await this.git.writeScopedWorktreeTree(paths, snapshot.head);
      if ((await this.git.listChangedPaths(snapshot.tree, live, paths)).length) throw new Error("Selected content changed while preparing the operation.");
    };
    if (paths.length) await verify();
    else await verifyClaims();
    const result: WorkingTreeResult = { status: "complete", commit: null, stash: null, message: "", warnings: [] };
    if (request.mode === "amend") {
      const amended = await new WorkbenchGitHistoryRewriter(this.git).amend({
        target: request.targetCommit!, expectedHead: snapshot.head!, targetTree: tree,
        message, messageOnly: paths.length === 0, paths,
        mutatePlan: async () => {
          if (paths.length) await verify();
          else await verifyClaims();
          return { replaceRefs: [], updates: [] };
        },
      });
      return { ...result, commit: amended.commit, message: "Commit amended.", warnings: amended.warnings };
    }
    if (request.mode === "commit") {
      const commit = await this.git.createCommitFromTree(tree, snapshot.head ? [snapshot.head] : [], message);
      const ref = await this.git.symbolicHead() ?? "HEAD";
      await verify();
      await this.git.publishRefsAfterIndexNormalization({
        indexCommit: commit, paths, updates: [{ ref, newValue: commit, oldValue: snapshot.head ?? "0".repeat(commit.length) }],
      });
      return { ...result, commit, message: "Changes committed." };
    }
    const remaining = await this.selectedTree(snapshot, request, true);
    const removalPatch = await this.git.run(["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", snapshot.tree, remaining]);
    await this.git.runWithInput(["apply", "--check", "--binary"], removalPatch);
    await verify();
    if (request.mode === "stash") {
      const indexCommit = await this.git.createCommitFromTree(base, [snapshot.head!], "index for selected stash");
      const stash = await this.git.createCommitFromTree(tree, [snapshot.head!, indexCommit], message || "Selected Workbench changes");
      await this.git.run(["stash", "store", "-m", message || "Selected Workbench changes", stash]);
      result.stash = stash;
    }
    try {
      await verify();
      await this.git.runWithInput(["apply", "--binary"], removalPatch);
      const removedTree = await this.git.writeScopedWorktreeTree(paths, snapshot.head);
      if ((await this.git.listChangedPaths(remaining, removedTree, paths)).length) {
        throw new Error("The worktree does not match the reviewed remainder. Submodule worktrees may require manual checkout.");
      }
      await this.git.resetMixedPaths(base, paths);
    } catch (error) {
      return {
        ...result, status: "incomplete",
        message: result.stash
          ? "Stash saved, but removing the selected worktree changes did not complete. Inspect before retrying."
          : "Discard did not complete. Inspect the worktree before retrying.",
        warnings: [error instanceof Error ? error.message.slice(0, 500) : "Git removal failed."],
      };
    }
    return { ...result, message: result.stash ? "Selected changes stashed." : "Selected changes discarded." };
  }
}
