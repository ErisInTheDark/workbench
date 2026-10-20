/*
 * Exports:
 * - isSamePath: compare two filesystem locations after resolution, case-insensitively on Windows.
 */
import path from "node:path";

export function isSamePath(left: string, right: string) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLocaleLowerCase() === resolvedRight.toLocaleLowerCase()
    : resolvedLeft === resolvedRight;
}
