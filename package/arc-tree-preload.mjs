// @ts-check
/*
 * No exports. Node `--import` preload, plain JavaScript so it loads before any TypeScript loader exists: answer reads of
 * other threads' held paths from the arc tree manifest, and make paths the caller's arc tree lacks look absent.
 * Node's module resolver stats files internally, so it still finds hidden files; reading them then fails as missing.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARC_TREE_MANIFEST_ENV, arcTreePathKey, readArcTreeManifest } from "./arc-tree-manifest.mjs";

/** @typedef {(error: NodeJS.ErrnoException | null, value?: unknown) => void} Callback */
/** @typedef {(...values: unknown[]) => unknown} LooseFunction */

/** @param {Map<string, Buffer | null>} overlay */
function install(overlay) {
  /** @param {unknown} target */
  const keyOf = (target) => {
    if (typeof target === "string") return arcTreePathKey(target);
    if (target instanceof URL) return target.protocol === "file:" ? arcTreePathKey(fileURLToPath(target)) : null;
    if (Buffer.isBuffer(target)) return arcTreePathKey(target.toString());
    return null;
  };
  /**
   * @param {unknown} target
   * @returns {Buffer | null | undefined} undefined when no other thread holds the path
   */
  const held = (target) => {
    const key = keyOf(target);
    return key === null ? undefined : overlay.get(key);
  };
  /** @param {string} syscall @param {unknown} target */
  const missing = (syscall, target) => Object.assign(
    new Error(`ENOENT: no such file or directory, ${syscall} '${String(target)}'`),
    { code: "ENOENT", errno: -os.constants.errno.ENOENT, path: String(target), syscall },
  );
  /** @param {Buffer} content @param {unknown} options */
  const encoded = (content, options) => {
    const encoding = typeof options === "string"
      ? /** @type {BufferEncoding} */ (options)
      : /** @type {{ encoding?: BufferEncoding | null } | undefined} */ (options)?.encoding;
    return encoding ? content.toString(encoding) : Buffer.from(content);
  };
  /** @param {unknown} directory @param {unknown[]} entries */
  const visible = (directory, entries) => entries.filter((entry) => {
    const dirent = entry instanceof fs.Dirent ? entry : null;
    const name = dirent ? dirent.name : entry;
    if (typeof name !== "string") return true;
    const parent = dirent ? dirent.parentPath : directory instanceof URL ? fileURLToPath(directory) : String(directory);
    return overlay.get(arcTreePathKey(path.join(parent, name))) !== null;
  });
  /** @param {unknown[]} args */
  const callbackOf = (args) => /** @type {Callback} */ (args.at(-1));
  /** @param {Callback} callback @param {NodeJS.ErrnoException | null} error @param {unknown} [value] */
  const later = (callback, error, value) => process.nextTick(() => callback(error, value));

  const { promises } = fs;
  const original = {
    access: /** @type {LooseFunction} */ (fs.access),
    accessSync: fs.accessSync,
    existsSync: fs.existsSync,
    lstat: /** @type {LooseFunction} */ (fs.lstat),
    lstatSync: /** @type {LooseFunction} */ (fs.lstatSync),
    promisesAccess: promises.access,
    promisesLstat: /** @type {LooseFunction} */ (promises.lstat),
    promisesReadFile: /** @type {LooseFunction} */ (promises.readFile),
    promisesReaddir: /** @type {LooseFunction} */ (promises.readdir),
    promisesStat: /** @type {LooseFunction} */ (promises.stat),
    readFile: /** @type {LooseFunction} */ (fs.readFile),
    readFileSync: /** @type {LooseFunction} */ (fs.readFileSync),
    readdir: /** @type {LooseFunction} */ (fs.readdir),
    readdirSync: /** @type {LooseFunction} */ (fs.readdirSync),
    stat: /** @type {LooseFunction} */ (fs.stat),
    statSync: /** @type {LooseFunction} */ (fs.statSync),
  };
  /** @param {string} syscall @param {LooseFunction} sync */
  const statSync = (syscall, sync) => (/** @type {unknown} */ target, /** @type {fs.StatSyncOptions | undefined} */ options) => {
    if (held(target) !== null) return sync.call(fs, target, options);
    if (options?.throwIfNoEntry === false) return undefined;
    throw missing(syscall, target);
  };
  /** @param {string} syscall @param {LooseFunction} callbackStat */
  const statCallback = (syscall, callbackStat) => (/** @type {unknown} */ target, /** @type {unknown[]} */ ...args) => {
    if (held(target) !== null) return callbackStat.call(fs, target, ...args);
    later(callbackOf(args), missing(syscall, target));
  };
  /** @param {string} syscall @param {LooseFunction} promiseStat */
  const statPromise = (syscall, promiseStat) => async (/** @type {unknown} */ target, /** @type {unknown} */ options) => {
    if (held(target) === null) throw missing(syscall, target);
    return await promiseStat.call(promises, target, options);
  };

  Object.assign(fs, {
    /** @param {unknown} target @param {unknown} [options] */
    readFileSync(target, options) {
      const content = held(target);
      if (content === undefined) return original.readFileSync.call(fs, target, options);
      if (content === null) throw missing("open", target);
      return encoded(content, options);
    },
    /** @param {unknown} target @param {unknown[]} args */
    readFile(target, ...args) {
      const content = held(target);
      if (content === undefined) return original.readFile.call(fs, target, ...args);
      if (content === null) later(callbackOf(args), missing("open", target));
      else later(callbackOf(args), null, encoded(content, args.length > 1 ? args[0] : undefined));
    },
    /** @param {fs.PathLike} target */
    existsSync(target) {
      return held(target) === null ? false : original.existsSync(target);
    },
    /** @param {fs.PathLike} target @param {number} [mode] */
    accessSync(target, mode) {
      if (held(target) === null) throw missing("access", target);
      original.accessSync(target, mode);
    },
    access: statCallback("access", original.access),
    statSync: statSync("stat", original.statSync),
    lstatSync: statSync("lstat", original.lstatSync),
    stat: statCallback("stat", original.stat),
    lstat: statCallback("lstat", original.lstat),
    /** @param {unknown} directory @param {unknown} [options] */
    readdirSync(directory, options) {
      return visible(directory, /** @type {unknown[]} */ (original.readdirSync.call(fs, directory, options)));
    },
    /** @param {unknown} directory @param {unknown[]} args */
    readdir(directory, ...args) {
      const callback = callbackOf(args);
      original.readdir.call(fs, directory, ...args.slice(0, -1), /** @type {Callback} */ ((error, entries) => {
        callback(error, error ? undefined : visible(directory, /** @type {unknown[]} */ (entries ?? [])));
      }));
    },
  });
  Object.assign(promises, {
    /** @param {unknown} target @param {unknown} [options] */
    async readFile(target, options) {
      const content = held(target);
      if (content === undefined) return await original.promisesReadFile.call(promises, target, options);
      if (content === null) throw missing("open", target);
      return encoded(content, options);
    },
    /** @param {fs.PathLike} target @param {number} [mode] */
    async access(target, mode) {
      if (held(target) === null) throw missing("access", target);
      await original.promisesAccess(target, mode);
    },
    stat: statPromise("stat", original.promisesStat),
    lstat: statPromise("lstat", original.promisesLstat),
    /** @param {unknown} directory @param {unknown} [options] */
    async readdir(directory, options) {
      return visible(directory, /** @type {unknown[]} */ (await original.promisesReaddir.call(promises, directory, options)));
    },
  });
  syncBuiltinESMExports();
}

const manifest = process.env[ARC_TREE_MANIFEST_ENV];
if (manifest) install(readArcTreeManifest(manifest));
