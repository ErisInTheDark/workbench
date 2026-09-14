/*
 * Keywords: native location, Windows, Linux, path comparison.
 * Exports:
 * - nativeLocationKey: compare native paths without changing their stored spelling.
 */
import path from "node:path";

export function nativeLocationKey(location: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path.posix.normalize(location);
  const native = location.replaceAll("/", "\\")
    .replace(/^\\\\\?\\UNC\\/iu, "\\\\")
    .replace(/^\\\\\?\\(?=[a-z]:\\)/iu, "");
  return path.win32.normalize(native).replace(/\\+$/u, "").toLowerCase();
}
