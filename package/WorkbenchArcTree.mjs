/*
 * Exports:
 * - default WorkbenchArcTree: the worktree as the calling agent thread builds it (other threads' held paths at the
 *   caller's arc baseline, everything else from disk), with in-process reads and a Node child-process environment.
 *   Falls back to the plain filesystem outside agent threads or when the daemon view fails.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ARC_TREE_MANIFEST_ENV, arcTreePathKey, writeArcTreeManifest } from "./arc-tree-manifest.mjs";
import { daemonGitArcIdentity, requestDaemonGitArc } from "./workbench-daemon.mjs";

const TREE_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** Keep every well-formed repository and held entry; each malformed one drops only itself. */
function conformRepositories(body, warn) {
  if (!body || typeof body !== "object" || !Array.isArray(body.repositories)) {
    throw new Error("the daemon's held-paths response lacks repositories");
  }
  let dropped = 0;
  const repositories = body.repositories.flatMap((repository) => {
    if (!repository || typeof repository !== "object" || !nonEmptyString(repository.repoRoot) || !TREE_SHA.test(String(repository.baseline))) {
      dropped++;
      return [];
    }
    const held = (Array.isArray(repository.held) ? repository.held : []).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || !nonEmptyString(entry.threadId) || !Array.isArray(entry.paths)) {
        dropped++;
        return [];
      }
      const paths = entry.paths.filter(nonEmptyString);
      dropped += entry.paths.length - paths.length;
      return [{ threadId: entry.threadId, paths }];
    });
    const head = typeof repository.head === "string" && TREE_SHA.test(repository.head) ? repository.head : null;
    return [{ root: path.resolve(repository.repoRoot), head, baseline: repository.baseline, held }];
  });
  if (dropped) warn(`Workbench arc tree dropped ${dropped} malformed daemon entr${dropped === 1 ? "y" : "ies"}; their paths read from disk.`);
  return repositories;
}

async function git(root, args, { input = "", signal } = {}) {
  const child = spawn("git", args, { cwd: root, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exit = new Promise((resolve, reject) => {
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
async function readTreeFiles(root, tree, paths, signal) {
  if (paths.some((relative) => relative.includes("\n"))) throw new Error("held paths containing newlines cannot be read from Git");
  const checks = paths.length
    ? (await git(root, ["cat-file", "--batch-check"], { input: paths.map((relative) => `${tree}:${relative}\n`).join(""), signal })).toString().split("\n")
    : [];
  return await Promise.all(paths.map(async (relative, index) => {
    const target = path.resolve(root, relative);
    if (checks[index].endsWith(" missing")) return [target, null];
    const [, type] = checks[index].split(" ");
    if (type !== "blob") throw new Error(`${relative} is a ${type} in the arc tree, not a file`);
    return [target, await git(root, ["cat-file", "--filters", `${tree}:${relative}`], { signal })];
  }));
}

function missing(target) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${target}'`), {
    code: "ENOENT", errno: -os.constants.errno.ENOENT, path: target, syscall: "open",
  });
}

export default class WorkbenchArcTree {
  #held;
  #manifest = null;

  constructor(source, cwd, files, repositories) {
    this.source = source;
    this.cwd = cwd;
    this.files = files;
    this.repositories = repositories;
    this.#held = new Map([...files].map(([target, content]) => [arcTreePathKey(target), content]));
  }

  static async load({ cwd = process.cwd(), holdOwn = false, env = process.env, fetch, signal, warn = () => {} } = {}) {
    const root = path.resolve(cwd);
    signal?.throwIfAborted();
    if (!daemonGitArcIdentity(env)) return new WorkbenchArcTree("filesystem", root, new Map(), []);
    try {
      const repositories = conformRepositories(
        await requestDaemonGitArc({ action: "arcHeld", cwd: root, holdOwn }, { env, fetch, signal }),
        warn,
      );
      if (!repositories.length) throw new Error(`no Workbench arc covers ${root}`);
      const files = new Map();
      for (const repository of repositories) {
        const held = [...new Set(repository.held.flatMap(({ paths }) => paths))];
        for (const [target, content] of await readTreeFiles(repository.root, repository.baseline, held, signal)) files.set(target, content);
      }
      return new WorkbenchArcTree("arc", root, files, repositories);
    } catch (error) {
      signal?.throwIfAborted();
      warn(`Workbench arc tree unavailable (${error instanceof Error ? error.message : String(error)}); reading the filesystem, including other threads' live edits.`);
      return new WorkbenchArcTree("filesystem", root, new Map(), []);
    }
  }

  static fromFiles(cwd, files, repositories = []) {
    const root = path.resolve(cwd);
    return new WorkbenchArcTree("arc", root, new Map([...files].map(([relative, content]) => [path.resolve(root, relative), content])), repositories);
  }

  get isEmpty() {
    return !this.files.size;
  }

  async readFile(target, encoding) {
    const resolved = path.resolve(this.cwd, target);
    const content = this.#held.get(arcTreePathKey(resolved));
    if (content === undefined) return await fs.promises.readFile(resolved, encoding ? { encoding } : undefined);
    if (content === null) throw missing(resolved);
    return encoding ? content.toString(encoding) : Buffer.from(content);
  }

  exists(target) {
    const resolved = path.resolve(this.cwd, target);
    const content = this.#held.get(arcTreePathKey(resolved));
    return content === undefined ? fs.existsSync(resolved) : content !== null;
  }

  get deletedOnDisk() {
    return [...this.files].flatMap(([target, content]) => content !== null && !fs.existsSync(target) ? [target] : []);
  }

  async nodeEnvironment({ env = process.env, directory } = {}) {
    if (this.isEmpty) return {};
    this.#manifest ??= this.#writeManifest(path.resolve(this.cwd, directory ?? path.join("node_modules", ".cache", "wb-arc-tree")));
    let file;
    try {
      ({ file } = await this.#manifest);
    } catch (error) {
      this.#manifest = null;
      throw error;
    }
    const preload = `--import ${new URL("./arc-tree-preload.mjs", import.meta.url).href}`;
    return { [ARC_TREE_MANIFEST_ENV]: file, NODE_OPTIONS: env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${preload}` : preload };
  }

  async #writeManifest(parent) {
    await fs.promises.mkdir(parent, { recursive: true });
    const directory = await fs.promises.mkdtemp(path.join(parent, "manifest-"));
    const file = path.join(directory, "manifest.json");
    try {
      await writeArcTreeManifest(file, this.files);
    } catch (error) {
      await fs.promises.rm(directory, { force: true, recursive: true });
      throw error;
    }
    return { directory, file };
  }

  async dispose() {
    const manifest = this.#manifest;
    this.#manifest = null;
    const written = await manifest?.catch(() => null);
    if (written) await fs.promises.rm(written.directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }
}
