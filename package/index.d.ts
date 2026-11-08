/*
 * Exports:
 * - WorkbenchConfigOptions: dotenv mapping, missing-value policies, store wait, cancellation and warning hooks.
 * - WorkbenchConfigOutput: mapped values after store replacement and policy checks, with the first file read error.
 * - WorkbenchConfigLookupFailure: one failed store reference behind a missing name.
 * - WorkbenchConfigError: rejection for missing required names; `retryable` marks temporarily unavailable stores.
 * - config: load and map dotenv values; resolve stores and check required names before environment writes.
 * - WorkbenchArcTree/WorkbenchArcTreeOptions/WorkbenchArcTreeRepository/WorkbenchArcTreeNodeEnvironmentOptions: arc tree types.
 * - arcTree: the worktree as the calling agent thread builds it, or the plain filesystem outside agent threads.
 */
import type WorkbenchArcTree from "./WorkbenchArcTree.mjs";
import type { WorkbenchArcTreeOptions } from "./WorkbenchArcTree.mjs";

export type { WorkbenchArcTree };
export type {
  WorkbenchArcTreeNodeEnvironmentOptions, WorkbenchArcTreeOptions, WorkbenchArcTreeRepository,
} from "./WorkbenchArcTree.mjs";
export type WorkbenchConfigOptions = {
  /** One file or several; earlier files win unless `override` is set. Defaults to `.env`. */
  path?: string | readonly string[];
  encoding?: BufferEncoding;
  /** Replace variables already present in `processEnv`, as dotenv does. */
  override?: boolean;
  processEnv?: Record<string, string | undefined>;
  /** Map merged parsed values before store resolution and policy checks. Rejection prevents environment writes. */
  map?: (env: Record<string, string>) => Record<string, string> | Promise<Record<string, string>>;
  /** Aborting kills running store commands and rejects. */
  signal?: AbortSignal;
  /** Opt into bounded lookup warnings that never contain command output. Silent by default. */
  warn?: (message: string) => void;
  /**
   * Keep retrying store lookups that exit 75 (EX_TEMPFAIL: store temporarily unavailable, such as `wb store get` before
   * Workbench is running) about once a second for roughly this many milliseconds. Other failures never wait. Defaults to 0.
   */
  storeWaitMs?: number;
} & ({
  /** Only these names are required; all other dotenv variables are optional. Empty values count as supplied. */
  required?: readonly string[];
  optional?: never;
} | {
  required?: never;
  /** These names are optional; all other dotenv variables are required. Empty values count as supplied. */
  optional?: readonly string[];
});

export interface WorkbenchConfigOutput {
  parsed: Record<string, string>;
  error?: Error;
}

export type WorkbenchConfigLookupFailure = {
  /** Variable whose store reference failed. */
  name: string;
  store: string;
  reason: "exit" | "missing-command" | "spawn-failed" | "output-limit" | "unknown-store" | "invalid-definitions";
  /** Present when `reason` is `exit`; 75 means the store was temporarily unavailable. */
  exitCode?: number;
};

/** Missing required names, with the store lookup failures behind them. Messages never contain keys, values or output. */
export class WorkbenchConfigError extends Error {
  readonly missing: readonly string[];
  readonly lookupFailures: readonly WorkbenchConfigLookupFailure[];
  /** True when every missing name failed only because its store was temporarily unavailable, so a later retry can succeed. */
  get retryable(): boolean;
}

/**
 * Without a policy, unresolved references remain literal. With a policy, missing optional
 * variables become empty strings in their entirety. Missing required names reject together
 * with a WorkbenchConfigError before any environment writes. Existing environment values win unless override is set.
 */
export function config(options?: WorkbenchConfigOptions): Promise<WorkbenchConfigOutput>;

/**
 * Other threads' held paths read at the caller's arc baseline; everything else reads from disk. Outside agent
 * threads, or when the daemon view fails (reported through `warn`), the plain filesystem. Only `signal` aborts reject.
 */
export function arcTree(options?: WorkbenchArcTreeOptions): Promise<WorkbenchArcTree>;
