/*
 * Exports:
 * - GitClaimPathRename: unambiguous repository-relative alias.
 * - default GitClaimRenameReader: read conservative committed rename chains.
 */
import type WorkbenchGitRepository from "./WorkbenchGitRepository";

export interface GitClaimPathRename {
  from: string;
  to: string;
}

interface PathHistory {
  arrivals: number;
  departures: number;
  next: string | null;
  neighbours: Set<string>;
}

export default class GitClaimRenameReader {
  async read(repository: WorkbenchGitRepository, head: string, signal: AbortSignal): Promise<GitClaimPathRename[]> {
    if ((await repository.run(["rev-parse", "--is-shallow-repository"], process.env, signal)).trim() !== "false") {
      throw new Error("Complete history is required to distinguish reused claim paths.");
    }
    const output = await repository.run([
      "log", "--first-parent", "--diff-merges=first-parent", "--root", "--format=",
      "--name-status", "-z", "--find-renames=50%", "--diff-filter=ADR", "--no-ext-diff", "--no-textconv", head, "--",
    ], process.env, signal);
    const histories = new Map<string, PathHistory>();
    const history = (file: string) => {
      let value = histories.get(file);
      if (!value) {
        value = { arrivals: 0, departures: 0, next: null, neighbours: new Set() };
        histories.set(file, value);
      }
      return value;
    };
    const fields = output.split("\0");
    if (fields.pop() !== "") throw new Error("Git rename history is not NUL terminated.");
    for (let index = 0; index < fields.length;) {
      const status = fields[index++]!;
      const source = fields[index++];
      if (!source || !/^(A|D|R\d+)$/u.test(status)) throw new Error("Git rename history contains an invalid change.");
      if (status === "A") history(source).arrivals += 1;
      else if (status === "D") history(source).departures += 1;
      else {
        const target = fields[index++];
        if (!target) throw new Error("Git rename history is missing a destination.");
        const before = history(source);
        const after = history(target);
        before.departures += 1;
        before.next = target;
        before.neighbours.add(target);
        after.arrivals += 1;
        after.neighbours.add(source);
      }
    }
    const visited = new Set<string>();
    const renames: GitClaimPathRename[] = [];
    for (const [file, entry] of histories) {
      if (!entry.next || visited.has(file)) continue;
      const component: string[] = [];
      const pending = [file];
      while (pending.length) {
        const candidate = pending.pop()!;
        if (visited.has(candidate)) continue;
        visited.add(candidate);
        component.push(candidate);
        pending.push(...histories.get(candidate)!.neighbours);
      }
      // More than one arrival/departure means the name was reused, even if the file is now absent.
      if (component.some((candidate) => {
        const value = histories.get(candidate)!;
        return value.arrivals !== 1 || value.departures > 1;
      })) continue;
      const terminals = component.filter((candidate) => !histories.get(candidate)!.next);
      if (terminals.length !== 1) continue;
      for (const from of component) {
        if (from !== terminals[0]) renames.push({ from, to: terminals[0]! });
      }
    }
    return renames.sort((left, right) => left.from.localeCompare(right.from));
  }
}
