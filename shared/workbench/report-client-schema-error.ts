/*
 * Exports:
 * - default reportClientSchemaError: log bounded nested Zod issue paths and messages without serializing rejected payload values. Keywords: browser, schema, Zod, error, log.
 */
import type { ZodError, ZodIssue } from "zod";

const MAX_LOGGED_ISSUES = 5;
const MAX_LOGGED_CHARACTERS = 1_000;

function flattenIssue(issue: ZodIssue): ZodIssue[] {
  return issue.code === "invalid_union"
    ? issue.errors.flatMap((branch) => branch.flatMap(flattenIssue))
    : [issue];
}

export default function reportClientSchemaError(context: string, error: ZodError) {
  const detail = error.issues
    .flatMap(flattenIssue)
    .sort((left, right) => Number(right.code === "unrecognized_keys") - Number(left.code === "unrecognized_keys") || right.path.length - left.path.length)
    .slice(0, MAX_LOGGED_ISSUES)
    .map((issue) => {
      const issuePath = issue.path.map(String).join(".") || "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ")
    .slice(0, MAX_LOGGED_CHARACTERS);
  console.error(`${context}: ${detail || "<root>: Invalid schema value"}`);
}
