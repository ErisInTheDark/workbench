/*
 * Exports:
 * - ReloadSourceWatchScope: literal sources and ordered patterns belonging to one reload scope.
 * - ReloadSourceWatcherOptions: source coverage, filesystem observation and change/error boundaries.
 * - default ReloadSourceWatcher: own source-directory subscriptions without watching unrelated subtrees.
 */
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { createGitignoreMatcher } from "../source-pattern-matcher.ts";

export interface ReloadSourceWatchScope {
  paths: readonly string[];
  patterns?: readonly string[];
}

export interface ReloadSourceWatcherOptions {
  root: string;
  getScopes(): readonly ReloadSourceWatchScope[];
  onChange(): void;
  onError(error: Error): void;
  isPotentialSourcePath?(relative: string): boolean;
  watchSource?: typeof watch;
}

function related(left: string, right: string) {
  return !left || !right || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalized(sourcePath: string) {
  return sourcePath.replaceAll("\\", "/").replace(/^\.\/|^\/+|\/+$/gu, "").replace(/^\.$/u, "");
}

function scopeMatcher(scope: ReloadSourceWatchScope) {
  const paths = scope.paths.map(normalized);
  const patterns = scope.patterns ?? [];
  const matcher = createGitignoreMatcher(patterns.join("\n"));
  const roots = patterns.flatMap((raw, index) => {
    const pattern = raw.trim();
    if (!pattern || pattern.startsWith("!") || pattern.startsWith("#")) return [];
    const wildcard = pattern.search(/[*?]/u);
    const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
    const excluded = createGitignoreMatcher(patterns.slice(index + 1)
      .map(pattern => pattern.trim())
      .filter(pattern => pattern.startsWith("!") && (pattern.endsWith("/**") || pattern.endsWith("/")))
      .map(pattern => pattern.slice(1)).join("\n"));
    return [{ path: normalized(wildcard < 0 ? prefix : prefix.slice(0, prefix.lastIndexOf("/") + 1)), excluded }];
  });
  return {
    directory(relative: string) {
      if (paths.some(source => related(source, relative))) return true;
      return roots.some(root => related(root.path, relative) && !root.excluded.matches(`${relative}/__directory__`));
    },
    file(relative: string) {
      return paths.some(source => !source || source === relative || relative.startsWith(`${source}/`))
        || matcher.matches(relative);
    },
  };
}

export default class ReloadSourceWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private closed = false;
  private reconcileRequested = false;
  private reconciling: Promise<void> | null = null;

  constructor(private readonly options: ReloadSourceWatcherOptions) {}

  async refresh() {
    if (this.closed) return;
    this.reconcileRequested = true;
    if (!this.reconciling) {
      this.reconciling = this.reconcile().finally(() => { this.reconciling = null; });
    }
    await this.reconciling;
  }

  close() {
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private async reconcile() {
    while (this.reconcileRequested && !this.closed) {
      this.reconcileRequested = false;
      const scopes = this.options.getScopes().map(scopeMatcher);
      const desired = new Set<string>();
      const visit = async (relative: string) => {
        if (this.closed) return;
        const absolute = path.join(this.options.root, relative);
        let entries;
        try {
          // Subscribe before listing so a directory created during discovery is not lost.
          if (!this.watchers.has(relative)) this.attach(relative);
          entries = await readdir(absolute, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
          return;
        }
        desired.add(relative);
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === ".git") continue;
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          if (this.options.isPotentialSourcePath || scopes.some(scope => scope.directory(child))) await visit(child);
        }
      };
      await visit("");
      if (this.closed) return;
      for (const [relative, watcher] of this.watchers) {
        if (desired.has(relative)) continue;
        watcher.close();
        this.watchers.delete(relative);
      }
    }
  }

  private attach(relative: string) {
    const watcher = (this.options.watchSource ?? watch)(
      path.join(this.options.root, relative),
      { recursive: false },
      (event, filename) => {
        if (this.closed) return;
        const source = filename === null ? null : normalized(path.posix.join(relative, String(filename).replaceAll("\\", "/")));
        void this.changed(relative, event, source).catch(error => {
          if (!this.closed) this.options.onError(error instanceof Error ? error : new Error(String(error)));
        });
      },
    );
    watcher.on("error", error => { if (!this.closed) this.options.onError(error); });
    this.watchers.set(relative, watcher);
  }

  private async changed(relative: string, event: string, source: string | null) {
    const scopes = this.options.getScopes().map(scopeMatcher);
    const fileChanged = source !== null && (
      scopes.some(scope => scope.file(source)) || this.options.isPotentialSourcePath?.(source)
    );
    let directoryChanged = source !== null && this.watchers.has(source);
    // Directory access/attribute notifications do not change source content.
    if (directoryChanged && event === "change") return;
    if (source !== null && !fileChanged && !directoryChanged && event === "rename" && scopes.some(scope => scope.directory(source))) {
      try {
        directoryChanged = (await stat(path.join(this.options.root, source))).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
        // An absent source-bearing directory may have been removed before discovery.
        directoryChanged = true;
      }
    }
    if (this.closed || (source !== null && !fileChanged && !directoryChanged)) return;
    if (event === "rename" || source === null) {
      // Directory replacement invalidates the old handle even when the pathname survives.
      for (const [directory, handle] of this.watchers) {
        if (directory && (source === null ? directory.startsWith(relative ? `${relative}/` : "") : directory === source || directory.startsWith(`${source}/`))) {
          handle.close();
          this.watchers.delete(directory);
        }
      }
      await this.refresh();
    }
    if (!this.closed) this.options.onChange();
  }
}
