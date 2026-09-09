/*
 * Keywords: transcript, CLI, SQLite, project admission.
 * Exports:
 * - WORKBENCH_TRANSCRIPT_COMMANDS: CLI-only stored-history discovery, search and reading.
 */
import { TranscriptQuerySchema, type TranscriptQuery } from "../../../orchestrator/database/transcript/transcript-query-contract";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const commonValues = ["--project", "--harness", "--since", "--until", "--archived", "--settled", "--limit", "--cursor"];
const itemValues = ["--turn", "--phase", "--tool", "--file"];
const descriptors = [
  { action: "projects", description: "List stored transcript projects, roots and thread counts." },
  { action: "threads", description: "Find stored threads by title and metadata. Returned ids are Workbench thread ids." },
  { action: "turns", description: "List a Workbench thread's turns and stored-body coverage." },
  { action: "search", description: "Search SQLite transcript fields across projects or exact --thread Workbench ids. No provider reads." },
  { action: "read", description: "Read stored history chronologically, optionally around a matching item." },
  { action: "show", description: "Expand a stored item through bounded field pages. Use the returned continuation." },
  { action: "stats", description: "Count stored threads, turns, materialised turns and item kinds." },
] as const;

function timestamp(value: string | null) {
  if (value === null) return null;
  if (/^\d+$/u.test(value)) return Number(value);
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)) throw new Error("Dates must be UTC dates, timezone-qualified ISO timestamps or epoch milliseconds.");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid transcript timestamp.");
  return parsed;
}

function booleanValue(flags: WorkbenchAgentCommandFlags, name: string) {
  const value = flags.optional(name);
  if (value === null) return null;
  if (value !== "true" && value !== "false") throw new Error(`${name} requires true or false.`);
  return value === "true";
}

function parse(action: TranscriptQuery["action"], args: string[]) {
  const itemAction = ["search", "read", "stats"].includes(action);
  const matching = action === "search" || action === "threads";
  const flags = new WorkbenchAgentCommandFlags(args, {
    values: [...commonValues, ...(itemAction ? itemValues : []), ...(action === "turns" ? ["--turn"] : []),
      ...(["read", "turns", "search"].includes(action) ? ["--direction"] : []),
      ...(action === "show" ? ["--item"] : []), ...(action === "read" ? ["--around", "--context"] : [])],
    repeatable: ["--thread", ...(itemAction ? ["--kind"] : []), ...(matching ? ["--query", "--exclude"] : [])],
    boolean: ["--json", ...(["search", "read", "show"].includes(action) ? ["--opaque"] : []), ...(matching ? ["--any", "--case-sensitive"] : [])],
    leadingDashValues: ["--query", "--exclude"],
  });
  return TranscriptQuerySchema.parse({
    action, threads: flags.repeated("--thread"), project: flags.optional("--project"), harness: flags.optional("--harness"),
    turn: flags.optional("--turn"), kinds: flags.repeated("--kind"), phase: flags.optional("--phase"),
    tool: flags.optional("--tool"), file: flags.optional("--file"), since: timestamp(flags.optional("--since")), until: timestamp(flags.optional("--until")),
    archived: booleanValue(flags, "--archived"), settled: booleanValue(flags, "--settled"),
    queries: flags.repeated("--query"), excludes: flags.repeated("--exclude"), any: flags.has("--any"),
    caseSensitive: flags.has("--case-sensitive"), opaque: flags.has("--opaque"), item: flags.optional("--item"),
    around: flags.optional("--around"), context: flags.optionalNonNegativeInteger("--context") ?? 5,
    limit: flags.optionalNonNegativeInteger("--limit") ?? 20, direction: flags.optional("--direction") ?? "older",
    cursor: flags.optional("--cursor"), json: flags.has("--json"),
  });
}

export const WORKBENCH_TRANSCRIPT_COMMANDS = descriptors.map(({ action, description }) => defineWorkbenchAgentCommand({
  description,
  effects: { readOnly: true, idempotent: true, openWorld: false },
  helpGroups: ["transcript"],
  hideFromMcp: true,
  managedThreadRootOnly: true,
  words: ["transcript", action],
  usage: `wb transcript ${action}${["read", "show", "turns"].includes(action) ? " --thread <wb-id>" : " [--thread <wb-id>...]"}${action === "search" ? " --query <text>" : ""}${action === "show" ? " --item <id>" : ""} [options]`,
  inputSchema: TranscriptQuerySchema,
  parseCliArgs: args => parse(action, args),
  buildRequest(input, { callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/internal/transcript", { ...input, action, callerThreadId, cwd });
  },
}));
