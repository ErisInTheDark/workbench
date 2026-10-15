/*
 * Exports:
 * - WorkbenchConfigOptions: dotenv mapping, missing-value policies, cancellation and warning hooks.
 * - WorkbenchConfigOutput: mapped values after store replacement and policy checks, with the first file read error.
 * - config: load and map dotenv values; resolve stores and check required names before environment writes.
 */
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

/**
 * Without a policy, unresolved references remain literal. With a policy, missing optional
 * variables become empty strings in their entirety. Missing required names reject together
 * before any environment writes. Existing environment values win unless override is set.
 */
export function config(options?: WorkbenchConfigOptions): Promise<WorkbenchConfigOutput>;
