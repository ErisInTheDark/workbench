/*
 * Exports:
 * - GitClaimPathRename: unambiguous repository-relative alias.
 * - default GitClaimRenameReader: read conservative committed rename chains, optionally only since a claim boundary.
 */
import type WorkbenchGitRepository from "./WorkbenchGitRepository";

export interface GitClaimPathRename {
  from: string;
  to: string;
}

interface PathHistory {
  /** Log positions; git lists newest commits first, so a larger position is older. */
  arrivals: number[];
  departures: number[];
  next: string | null;
  neighbours: Set<string>;
}

export default class GitClaimRenameReader {
  /**
   * Without `since`, every name must have exactly one arrival in complete history. With `since`, only
   * renames after that boundary can alias claims, so a name present before it may have no arrival.
   */
  async read(repository: WorkbenchGitRepository, head: string, signal: AbortSignal, since: number | null = null): Promise<GitClaimPathRename[]> {
    if ((await repository.run(["rev-parse", "--is-shallow-repository"], process.env, signal)).trim() !== "false") {
      throw new Error("Complete history is required to distinguish reused claim paths.");
    }
    const output = await repository.run([
      "log", "--first-parent", "--diff-merges=first-parent", "--root", "--format=",
      ...(since === null ? [] : [`--since=${new Date(since).toISOString()}`]),
      "--name-status", "-z", "--find-renames=50%", "--diff-filter=ADR", "--no-ext-diff", "--no-textconv", head, "--",
    ], process.env, signal);
    const histories = new Map<string, PathHistory>();
    const history = (file: string) => {
      let value = histories.get(file);
      if (!value) {
        value = { arrivals: [], departures: [], next: null, neighbours: new Set() };
        histories.set(file, value);
      }
      return value;
    };
    const fields = output.split("\0");
    if (fields.pop() !== "") throw new Error("Git rename history is not NUL terminated.");
    let position = 0;
    for (let index = 0; index < fields.length; position += 1) {
      const status = fields[index++]!;
      const source = fields[index++];
      if (!source || !/^(A|D|R\d+)$/u.test(status)) throw new Error("Git rename history contains an invalid change.");
      if (status === "A") history(source).arrivals.push(position);
      else if (status === "D") history(source).departures.push(position);
      else {
        const target = fields[index++];
        if (!target) throw new Error("Git rename history is missing a destination.");
        const before = history(source);
        const after = history(target);
        before.departures.push(position);
        before.next = target;
        before.neighbours.add(target);
        after.arrivals.push(position);
        after.neighbours.add(source);
      }
    }
    // One generation per name: at most one arrival and departure, arriving before it leaves.
    const ambiguous = (value: PathHistory) => value.arrivals.length > 1 || value.departures.length > 1
      || (since === null && value.arrivals.length !== 1)
      || (value.arrivals.length === 1 && value.departures.length === 1 && value.arrivals[0]! < value.departures[0]!);
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
      if (component.some((candidate) => ambiguous(histories.get(candidate)!))) continue;
      const terminals = component.filter((candidate) => !histories.get(candidate)!.next);
      if (terminals.length !== 1) continue;
      for (const from of component) {
        if (from !== terminals[0]) renames.push({ from, to: terminals[0]! });
      }
    }
    return renames.sort((left, right) => left.from.localeCompare(right.from));
  }
}
