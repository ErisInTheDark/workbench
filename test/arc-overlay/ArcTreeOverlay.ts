/*
 * Exports:
 * - default ArcTreeOverlay: the caller's arc tree at paths other threads hold, for typecheck file system layers and
 *   manifest-backed test process environments.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GitArcClaimViewResultSchema } from "../../shared/workbench/git/checkpoint-contracts";
import WorkbenchTemporaryDirectory from "../../shared/WorkbenchTemporaryDirectory";
import { daemonGitArcIdentity, requestDaemonGitArc, type DaemonGitArcRequestOptions } from "../daemon-git-arc-request";
import { arcOverlayProcessEnvironment, writeArcOverlayManifest, type ArcOverlayFiles } from "./arc-overlay-manifest";

async function git(root: string, args: readonly string[], input = "") {
  const child = spawn("git", args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(input);
  if (await exit !== 0) throw new Error(`git ${args[0]} failed: ${Buffer.concat(stderr).toString().trim()}`);
  return Buffer.concat(stdout);
}

/**
 * Each path's bytes in `tree` as a checkout would write them, or null where the tree lacks it. Batch reads skip
 * checkout filters, so only the existence check is batched.
 */
async function readTreeFiles(root: string, tree: string, paths: readonly string[]) {
  if (paths.some(relative => relative.includes("\n"))) throw new Error("held paths containing newlines cannot be read from Git");
  const checks = paths.length
    ? (await git(root, ["cat-file", "--batch-check"], paths.map(relative => `${tree}:${relative}\n`).join(""))).toString().split("\n")
    : [];
  return new Map(await Promise.all(paths.map(async (relative, index) => {
    const [, type] = checks[index]!.split(" ");
    if (checks[index]!.endsWith(" missing")) return [relative, null] as const;
    if (type !== "blob") throw new Error(`${relative} is a ${type} in the arc tree, not a file`);
    return [relative, await git(root, ["cat-file", "--filters", `${tree}:${relative}`])] as const;
  })));
}

export default class ArcTreeOverlay {
  private manifest: { directory: WorkbenchTemporaryDirectory; file: string } | null = null;

  /** `files` maps absolute held paths to arc tree bytes, or null where that tree lacks them. */
  private constructor(private readonly root: string, readonly files: ArcOverlayFiles, private readonly owners: number) {}

  /** `files` maps repository-relative paths to arc tree bytes, or null where that tree lacks them. */
  static fromFiles(root: string, files: ReadonlyMap<string, Buffer | null>, owners: number) {
    return new ArcTreeOverlay(root, new Map([...files].map(([relative, content]) => [path.resolve(root, relative), content])), owners);
  }

  /**
   * The calling agent thread's overlay, or null outside agent threads. A daemon or Git failure is reported through
   * `output` and also yields null, so callers still run, visibly against the live worktree.
   */
  static async load(input: DaemonGitArcRequestOptions & { output: (line: string) => void; root: string }) {
    if (!daemonGitArcIdentity(input.env)) return null;
    let overlay: ArcTreeOverlay;
    try {
      const { repositories } = GitArcClaimViewResultSchema.parse(await requestDaemonGitArc(
        { action: "arcTree", cwd: input.root, holdOwn: false, paths: [] }, input,
      ));
      const view = repositories.find(({ repoRoot }) => !path.relative(input.root, path.resolve(repoRoot)));
      if (!view) throw new Error("the daemon returned no view of this repository");
      const held = [...new Set(view.held.flatMap(({ paths }) => paths))];
      overlay = ArcTreeOverlay.fromFiles(input.root, await readTreeFiles(input.root, view.tree, held), view.held.length);
    } catch (error) {
      input.output(`arc overlay unavailable (${error instanceof Error ? error.message : String(error)}); results include other threads' live edits.`);
      return null;
    }
    input.output(overlay.describe());
    return overlay;
  }

  get isEmpty() {
    return !this.files.size;
  }

  describe() {
    if (this.isEmpty) return "arc overlay: no other threads' live edits to hold back.";
    const lines = [`arc overlay: ${this.files.size} path(s) from ${this.owners} other thread(s) held at your arc baseline.`];
    const unrestorable = [...this.files].filter(([target, content]) => content !== null && !fs.existsSync(target));
    if (unrestorable.length) {
      const names = unrestorable.map(([target]) => path.relative(this.root, target).replaceAll("\\", "/"));
      lines.push(`  deleted on disk, so tests still miss them (typecheck restores them): ${names.join(", ")}`);
    }
    return lines.join("\n");
  }

  /** Environment that makes Node test processes and their Node descendants read held paths from this overlay. */
  async prepareTestEnvironment(environment: NodeJS.ProcessEnv): Promise<Record<string, string>> {
    if (this.isEmpty) return {};
    if (!this.manifest) {
      const directory = await WorkbenchTemporaryDirectory.create("arc-overlay-");
      const file = path.join(directory.path, "manifest.json");
      try {
        await writeArcOverlayManifest(file, this.files);
      } catch (error) {
        await directory.dispose();
        throw error;
      }
      this.manifest = { directory, file };
    }
    return arcOverlayProcessEnvironment(this.manifest.file, environment);
  }

  async dispose() {
    await this.manifest?.directory.dispose();
    this.manifest = null;
  }
}
