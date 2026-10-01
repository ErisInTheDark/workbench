/*
 * Exports:
 * - default reportClientSchemaError: log bounded nested Zod issue paths and messages without serializing rejected payload values.
 */
import type { ZodError, ZodIssue } from "zod";

const MAX_LOGGED_ISSUES = 5;
const MAX_LOGGED_CHARACTERS = 1_000;

type ReportedIssue = { code: ZodIssue["code"]; path: PropertyKey[]; message: string };

// Zod stores union branch issues relative to the union, so prefix the union's own path while flattening.
// A union without branch issues (no matching discriminator) is kept so the failure never disappears.
function flattenIssue(issue: ZodIssue, prefix: PropertyKey[] = []): ReportedIssue[] {
  const path = [...prefix, ...issue.path];
  if (issue.code === "invalid_union") {
    const branches = issue.errors.flatMap((branch) => branch.flatMap((nested) => flattenIssue(nested, path)));
    if (branches.length > 0) return branches;
    const note = "note" in issue && typeof issue.note === "string" ? ` (${issue.note})` : "";
    return [{ code: issue.code, path, message: `${issue.message}${note}` }];
  }
  return [{ code: issue.code, path, message: issue.message }];
}

export default function reportClientSchemaError(context: string, error: ZodError) {
  const issues = error.issues
    .flatMap((issue) => flattenIssue(issue))
    .sort((left, right) => Number(right.code === "unrecognized_keys") - Number(left.code === "unrecognized_keys") || right.path.length - left.path.length);
  const omitted = issues.length - MAX_LOGGED_ISSUES;
  const detail = issues
    .slice(0, MAX_LOGGED_ISSUES)
    .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
    .join("; ")
    .concat(omitted > 0 ? ` (+${omitted} more issues)` : "")
    .slice(0, MAX_LOGGED_CHARACTERS);
  console.error(`${context}: ${detail || "<root>: Invalid schema value"}`);
}
