/*
 * Exports:
 * - STORE_UNAVAILABLE_EXIT_CODE: sysexits EX_TEMPFAIL; store commands exit with it while the store is temporarily unreachable.
 * - lookupFailureDetail: bounded description of one failed store lookup, never containing keys or output.
 * - default WorkbenchConfigError: missing required config names with the store lookup failures behind them and whether retrying can help.
 */

export const STORE_UNAVAILABLE_EXIT_CODE = 75;

export function lookupFailureDetail({ reason, exitCode }) {
  return reason === "exit" ? `exited with ${exitCode}` : `failed (${reason})`;
}

export default class WorkbenchConfigError extends Error {
  constructor(missing, lookupFailures) {
    const failed = lookupFailures.map(failure => `${failure.name} (${failure.store} ${lookupFailureDetail(failure)})`);
    super(`Missing required environment variables: ${missing.join(", ")}${failed.length ? `. Failed store lookups: ${failed.join(", ")}` : ""}`);
    this.name = "WorkbenchConfigError";
    this.missing = missing;
    this.lookupFailures = lookupFailures;
  }

  get retryable() {
    return this.missing.every(name => this.lookupFailures.some(failure => failure.name === name))
      && this.lookupFailures.every(failure => failure.exitCode === STORE_UNAVAILABLE_EXIT_CODE);
  }
}
