/*
 * Exports:
 * - normalizePathKey: forward-slash, case-folded (win32) path key without trailing separators, except a filesystem root's own.
 * - comparablePath: normalizePathKey of a resolved path.
 * - isPathInside: whether a path is a root or below it, including filesystem roots such as `/` and `C:/`.
 */
import path from "node:path";

export function normalizePathKey(value: string, platform: NodeJS.Platform = process.platform) {
  const slashed = value.replace(/\\/gu, "/");
  const stripped = /^[a-z]:\/+$/iu.test(slashed) ? `${slashed.slice(0, 2)}/` : slashed.replace(/(?<=.)\/+$/u, "");
  return platform === "win32" ? stripped.toLowerCase() : stripped;
}

export function comparablePath(value: string, platform: NodeJS.Platform = process.platform) {
  return normalizePathKey(path.resolve(value), platform);
}

export function isPathInside(candidate: string, root: string, platform: NodeJS.Platform = process.platform) {
  const value = comparablePath(candidate, platform);
  const boundary = comparablePath(root, platform);
  return value === boundary || value.startsWith(boundary.endsWith("/") ? boundary : `${boundary}/`);
}
