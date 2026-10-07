/*
 * Exports:
 * - describeErrorCauseChain: flatten an error and its AggregateError causes into one bounded, sanitized line.
 */

/**
 * Shutdown failures are aggregated so every owner reports. The aggregate message alone hides
 * which owner refused, so callers log the nested causes. Depth and length stay bounded and no
 * payloads or values are ever serialized.
 */
export function describeErrorCauseChain(error: unknown, maxLength = 1000): string {
  const describe = (value: unknown, depth: number): string => {
    if (depth > 2) return "…";
    if (value instanceof AggregateError) {
      const nested = value.errors.map(item => describe(item, depth + 1)).filter(Boolean).join("; ");
      return nested || value.message;
    }
    if (value instanceof Error) return value.message;
    return String(value);
  };
  return describe(error, 0).slice(0, maxLength);
}
