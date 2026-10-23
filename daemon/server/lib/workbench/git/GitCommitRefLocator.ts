/*
 * Exports:
 * - default GitCommitRefLocator: process-level commit-to-ref index for one repository's namespace set, verifying every
 *   hit against the live ref and rescanning on any miss, so answers always match a fresh scan; publications this process
 *   makes are observed so their refs hit without scanning.
 * - GitCommitRefSource: the Git reads a lookup may use: a full namespace listing and a single-ref read.
 */
import path from "node:path";

export interface GitCommitRefSource {
  scan(): Promise<ReadonlyArray<{ ref: string; value: string }>>;
  verify(ref: string): Promise<string | null>;
}

/** Namespace sets kept warm; least recently used sets drop first. */
const MAX_LOCATORS = 64;
const locators = new Map<string, GitCommitRefLocator>();

function rootKey(root: string) {
  return path.resolve(root);
}

export default class GitCommitRefLocator {
  /** Refs by the commit they name; null until the first scan. */
  private byCommit: Map<string, Set<string>> | null = null;
  private byRef = new Map<string, string>();

  private constructor(private readonly namespaces: readonly string[]) {}

  static for(root: string, namespaces: readonly string[]) {
    const key = `${rootKey(root)}\0${[...namespaces].sort().join("\0")}`;
    const existing = locators.get(key);
    const locator = existing ?? new GitCommitRefLocator(namespaces);
    locators.delete(key);
    locators.set(key, locator);
    if (!existing && locators.size > MAX_LOCATORS) locators.delete(locators.keys().next().value!);
    return locator;
  }

  /** Apply refs this process just published in `root`; refs outside a locator's namespaces are ignored. */
  static observe(root: string, updates: ReadonlyArray<{ newValue: string; ref: string }>, deletes: ReadonlyArray<{ ref: string }>) {
    const prefix = `${rootKey(root)}\0`;
    for (const [key, locator] of locators) {
      if (!key.startsWith(prefix)) continue;
      for (const { ref } of deletes) locator.forget(ref);
      for (const { newValue, ref } of updates) {
        locator.forget(ref);
        if (locator.owns(ref)) locator.add(ref, newValue);
      }
    }
  }

  /** The smallest-named ref in the namespaces naming `commit`, or null when none does. */
  async locate(commit: string, source: GitCommitRefSource) {
    if (this.byCommit) {
      const verified = await this.firstVerified(commit, source);
      if (verified) return verified;
    }
    this.byCommit = new Map();
    this.byRef = new Map();
    for (const { ref, value } of await source.scan()) this.add(ref, value);
    return [...this.byCommit.get(commit) ?? []].sort()[0] ?? null;
  }

  private async firstVerified(commit: string, source: GitCommitRefSource) {
    for (const ref of [...this.byCommit?.get(commit) ?? []].sort()) {
      if (await source.verify(ref) === commit) return ref;
    }
    return null;
  }

  private owns(ref: string) {
    return this.namespaces.some(namespace => ref.startsWith(`${namespace}/`));
  }

  private add(ref: string, commit: string) {
    if (!this.byCommit) return;
    let refs = this.byCommit.get(commit);
    if (!refs) this.byCommit.set(commit, refs = new Set());
    refs.add(ref);
    this.byRef.set(ref, commit);
  }

  private forget(ref: string) {
    const commit = this.byRef.get(ref);
    if (commit === undefined) return;
    this.byRef.delete(ref);
    const refs = this.byCommit?.get(commit);
    if (refs?.delete(ref) && !refs.size) this.byCommit!.delete(commit);
  }
}
