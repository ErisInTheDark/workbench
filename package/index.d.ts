/*
 * Exports:
 * - WorkbenchConfigOptions: dotenv-compatible loading options plus cancellation and warning hooks.
 * - WorkbenchConfigOutput: parsed values after store replacement, with the first file read error.
 * - config: load dotenv files, then replace resolvable `${store:key}` references through named WB_STORES commands.
 */
export interface WorkbenchConfigOptions {
  /** One file or several; earlier files win unless `override` is set. Defaults to `.env`. */
  path?: string | readonly string[];
  encoding?: BufferEncoding;
  /** Replace variables already present in `processEnv`, as dotenv does. */
  override?: boolean;
  processEnv?: Record<string, string | undefined>;
  /** Aborting kills running store commands and rejects. */
  signal?: AbortSignal;
  /** Receives bounded messages that never contain command output. Defaults to `process.emitWarning`. */
  warn?: (message: string) => void;
}

export interface WorkbenchConfigOutput {
  parsed: Record<string, string>;
  error?: Error;
}

export function config(options?: WorkbenchConfigOptions): Promise<WorkbenchConfigOutput>;
