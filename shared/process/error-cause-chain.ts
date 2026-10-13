/*
 * Exports:
 * - describeErrorCauseChain: describe aggregate and standard causes with bounded traversal and single-line output.
 */

const MAX_CAUSE_DEPTH = 4;
const MAX_CAUSE_COUNT = 20;

export function describeErrorCauseChain(error: unknown, maxLength = 1000): string {
  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 1000;
  let message = "";
  let visited = 0;
  const seen = new Set<Error>();
  const append = (value: string) => {
    const remaining = limit - message.length;
    if (remaining <= 0) return;
    const clean = value.slice(0, remaining).replace(/[\u0000-\u001f\u007f-\u009f\s]+/gu, " ").trim();
    if (clean) message += `${message ? "; " : ""}${clean}`.slice(0, remaining);
  };
  const describe = (value: unknown, depth: number): void => {
    if (message.length >= limit || visited >= MAX_CAUSE_COUNT || depth > MAX_CAUSE_DEPTH) return;
    visited++;
    if (!(value instanceof Error)) {
      append(typeof value === "string" ? value : "non-Error rejection");
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    append(value.message);
    if (depth === MAX_CAUSE_DEPTH) return;
    if (value.cause !== undefined) describe(value.cause, depth + 1);
    if (value instanceof AggregateError) {
      for (const nested of value.errors) {
        if (visited >= MAX_CAUSE_COUNT || message.length >= limit) break;
        describe(nested, depth + 1);
      }
    }
  };
  describe(error, 0);
  return message;
}
