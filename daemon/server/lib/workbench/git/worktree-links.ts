/*
 * Exports:
 * - default WorktreeLinks: cached answers to whether worktree paths are, or are reached through, links or junctions.
 * Node reports Windows junctions as symbolic links, while Git for Windows walks them as plain directories, so Workbench
 * decides link boundaries itself instead of trusting Git's listings.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";

export default class WorktreeLinks {
  private readonly known = new Map<string, Promise<boolean>>();

  constructor(private readonly root: string) {}

  /** `relative` (a `/`-separated worktree path) is itself a link or junction; missing paths are not. */
  isLink(relative: string) {
    let isLink = this.known.get(relative);
    if (!isLink) {
      isLink = lstat(path.join(this.root, ...relative.split("/"))).then((stats) => stats.isSymbolicLink(), () => false);
      this.known.set(relative, isLink);
    }
    return isLink;
  }

  /** The outermost link among `relative` and its ancestors deeper than `depth` segments, else null. */
  async outermostLink(relative: string, depth = 0) {
    const segments = relative.split("/");
    for (let length = depth + 1; length <= segments.length; length += 1) {
      const candidate = segments.slice(0, length).join("/");
      if (await this.isLink(candidate)) return candidate;
    }
    return null;
  }

  /** Paths that neither are links nor lie beneath one. */
  async withoutLinked(paths: readonly string[]) {
    const linked = await Promise.all(paths.map(async (candidate) => await this.outermostLink(candidate) !== null));
    return paths.filter((_candidate, index) => !linked[index]);
  }
}
