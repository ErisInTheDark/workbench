/*
 * Exports:
 * - WorkbenchConfigOptions: dotenv loading, mutually exclusive missing-value policies, cancellation and warning hooks.
 * - WorkbenchConfigOutput: parsed values after store replacement, with the first file read error.
 * - config: load dotenv and store values; reject missing required names before writing the environment.
 */
export type WorkbenchConfigOptions = {
  /** One file or several; earlier files win unless `override` is set. Defaults to `.env`. */
  path?: string | readonly string[];
  encoding?: BufferEncoding;
  /** Replace variables already present in `processEnv`, as dotenv does. */
  override?: boolean;
  processEnv?: Record<string, string | undefined>;
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
