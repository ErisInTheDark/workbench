/*
 * Exports:
 * - WorkbenchArcTreeOptions: cwd, hold-own, environment, fetch, cancellation and warning boundaries for loading.
 * - WorkbenchArcTreeRepository: one repository's daemon view: HEAD, other threads' held paths and the baseline holding their bytes.
 * - WorkbenchArcTreeNodeEnvironmentOptions: base environment and manifest parent directory for Node children.
 * - default WorkbenchArcTree: the worktree as the calling agent thread builds it, readable in process and by Node
 *   children; the plain filesystem outside agent threads or when the daemon view fails.
 */
export interface WorkbenchArcTreeOptions {
  /** Directory whose repositories to view; relative reads resolve from it. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Hold the caller's own dirty claims back too, for a matched "before" build. */
  holdOwn?: boolean;
  /** Agent identity and data root come from here. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  /** Aborting stops the daemon request and Git reads, and rejects instead of falling back. */
  signal?: AbortSignal;
  /** Fallback and dropped-entry notices. Silent by default. */
  warn?: (message: string) => void;
}

export interface WorkbenchArcTreeRepository {
  /** Absolute repository root. */
  root: string;
  head: string | null;
  /** Git tree holding each held path as the caller builds it; other paths may differ from that build. */
  baseline: string;
  /** Repository-relative paths each other thread holds. */
  held: ReadonlyArray<{ threadId: string; paths: readonly string[] }>;
}

export interface WorkbenchArcTreeNodeEnvironmentOptions {
  /** `NODE_OPTIONS` is appended to, not replaced. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Parent of the manifest directory, relative to `cwd`. Defaults to `node_modules/.cache/wb-arc-tree`. Only the first call's value applies. */
  directory?: string;
}

export default class WorkbenchArcTree implements AsyncDisposable {
  private constructor();
  /**
   * Outside agent threads, the plain filesystem without asking the daemon. A daemon or Git failure warns and also
   * yields the plain filesystem, so callers still run, visibly against the live worktree. Never rejects for
   * unavailability; only `signal` aborts reject.
   */
  static load(options?: WorkbenchArcTreeOptions): Promise<WorkbenchArcTree>;
  /** A tree holding `files` (paths relative to `cwd`; null where the tree lacks them) without asking the daemon. */
  static fromFiles(cwd: string, files: ReadonlyMap<string, Buffer | null>, repositories?: readonly WorkbenchArcTreeRepository[]): WorkbenchArcTree;

  readonly source: "arc" | "filesystem";
  readonly cwd: string;
  /** Absolute held paths mapped to arc tree bytes, or null where the arc tree lacks them. Unlisted paths read from disk. */
  readonly files: ReadonlyMap<string, Buffer | null>;
  readonly repositories: readonly WorkbenchArcTreeRepository[];
  readonly isEmpty: boolean;

  /** Held bytes, ENOENT where the arc tree lacks the path, otherwise disk. */
  readFile(path: string): Promise<Buffer>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  exists(path: string): boolean;
  /** Absolute held paths this tree has but disk lacks; in-process reads see them, Node children cannot. */
  readonly deletedOnDisk: string[];
  /**
   * Variables to merge into a Node child's environment so it and its Node descendants read this tree. Empty when
   * nothing is held. Writes a manifest that `dispose` removes.
   */
  nodeEnvironment(options?: WorkbenchArcTreeNodeEnvironmentOptions): Promise<Record<string, string>>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
