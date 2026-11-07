/*
 * Exports:
 * - default WorkbenchArcTree: the worktree as the calling agent thread builds it (other threads' held paths at the
 *   caller's arc baseline, everything else from disk), with in-process reads and a Node child-process environment.
 *   Warns when held bytes differ from disk. Falls back to the plain filesystem outside agent threads or when the daemon view fails.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ARC_TREE_MANIFEST_ENV, arcTreePathKey, writeArcTreeManifest } from "./arc-tree-manifest.mjs";
import { daemonGitArcIdentity, requestDaemonGitArc } from "./workbench-daemon.mjs";

const TREE_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Keep every well-formed repository, held entry and held path's daemon-read bytes; each malformed one drops only
 * itself, so its path reads from disk.
 */
function conformRepositories(body, warn) {
  if (!body || typeof body !== "object" || !Array.isArray(body.repositories)) {
    throw new Error("the daemon's held-paths response lacks repositories");
  }
  let dropped = 0;
  const files = new Map();
  const repositories = body.repositories.flatMap((repository) => {
    if (!repository || typeof repository !== "object" || !nonEmptyString(repository.repoRoot) || !TREE_SHA.test(String(repository.baseline))) {
      dropped++;
      return [];
    }
    const root = path.resolve(repository.repoRoot);
    const contents = repository.contents && typeof repository.contents === "object" ? repository.contents : {};
    const held = (Array.isArray(repository.held) ? repository.held : []).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || !nonEmptyString(entry.threadId) || !Array.isArray(entry.paths)) {
        dropped++;
        return [];
      }
      const paths = entry.paths.filter((relative) => nonEmptyString(relative)
        && Object.hasOwn(contents, relative) && (contents[relative] === null || typeof contents[relative] === "string"));
      dropped += entry.paths.length - paths.length;
      for (const relative of paths) {
        files.set(path.resolve(root, relative), contents[relative] === null ? null : Buffer.from(contents[relative], "base64"));
      }
      return [{ threadId: entry.threadId, paths }];
    });
    const head = typeof repository.head === "string" && TREE_SHA.test(repository.head) ? repository.head : null;
    return [{ root, head, baseline: repository.baseline, held }];
  });
  if (dropped) warn(`Workbench arc tree dropped ${dropped} malformed daemon entr${dropped === 1 ? "y" : "ies"}; their paths read from disk.`);
  return { files, repositories };
}

const MIXED_SAMPLE_LIMIT = 5;
const MIXED_READ_BATCH = 64;

async function readDisk(target) {
  try {
    return await fs.promises.readFile(target);
  } catch {
    return null;
  }
}

/** One notice naming held paths whose bytes differ from disk, or null when the build reads as one tree. */
async function describeMixing(files, repositories, signal) {
  const targets = [...files.keys()];
  const differing = new Set();
  for (let offset = 0; offset < targets.length; offset += MIXED_READ_BATCH) {
    signal?.throwIfAborted();
    await Promise.all(targets.slice(offset, offset + MIXED_READ_BATCH).map(async (target) => {
      const held = files.get(target);
      const disk = await readDisk(target);
      if (held === null ? disk !== null : disk === null || !held.equals(disk)) differing.add(target);
    }));
  }
  if (!differing.size) return null;
  const threads = repositories.flatMap(({ root, held }) => held.flatMap(({ paths, threadId }) => {
    const listed = paths.filter(relative => differing.has(path.resolve(root, relative)));
    if (!listed.length) return [];
    const absent = listed.filter(relative => files.get(path.resolve(root, relative)) === null).length;
    const more = listed.length - MIXED_SAMPLE_LIMIT;
    return [`  thread ${threadId.slice(0, 8)}: ${listed.length} differ${absent ? `, ${absent} absent here` : ""}: ${listed.slice(0, MIXED_SAMPLE_LIMIT).join(", ")}${more > 0 ? ` (+${more} more)` : ""}`];
  }));
  return [
    `arc tree: ${differing.size} of ${files.size} held paths differ from disk, so this run mixes other threads' claims at your baseline with everything else from disk. holdOwn views only your sealed stack.`,
    ...threads,
  ].join("\n");
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

  static async load({ cwd = process.cwd(), holdOwn = false, env = process.env, fetch, signal, warn: notify } = {}) {
    const root = path.resolve(cwd);
    const warn = notify ?? (() => {});
    signal?.throwIfAborted();
    if (!daemonGitArcIdentity(env)) return new WorkbenchArcTree("filesystem", root, new Map(), []);
    let view;
    try {
      view = conformRepositories(
        await requestDaemonGitArc({ action: "arcHeld", contents: true, cwd: root, holdOwn }, { env, fetch, signal }),
        warn,
      );
      if (!view.repositories.length) throw new Error(`no Workbench arc covers ${root}`);
    } catch (error) {
      signal?.throwIfAborted();
      warn(`Workbench arc tree unavailable (${error instanceof Error ? error.message : String(error)}); reading the filesystem, including other threads' live edits.`);
      return new WorkbenchArcTree("filesystem", root, new Map(), []);
    }
    const { files, repositories } = view;
    if (notify && !holdOwn) {
      const mixing = await describeMixing(files, repositories, signal);
      if (mixing) notify(mixing);
    }
    return new WorkbenchArcTree("arc", root, files, repositories);
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
