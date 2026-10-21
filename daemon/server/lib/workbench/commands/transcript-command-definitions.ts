/*
 * Exports:
 * - WORKBENCH_TRANSCRIPT_COMMANDS: deferred stored-history discovery, search and reading; each action's CLI options and tool schema come from one field table.
 */
import {
  TRANSCRIPT_QUERY_ACTIONS,
  TranscriptCommandFieldsSchema,
  TranscriptCommandQuerySchema,
  type TranscriptCommandField,
  type TranscriptCommandQuery,
} from "../../../database/transcript/transcript-query-contract";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

type Action = TranscriptCommandQuery["action"];

const DESCRIPTIONS: Record<Action, string> = {
  projects: "List stored transcript projects, roots and thread counts.",
  threads: "Find stored threads by title and metadata. Returned ids are Workbench thread ids.",
  turns: "List a Workbench thread's turns and stored-body coverage.",
  search: "Search SQLite transcript fields across projects or exact --thread Workbench ids. No provider reads.",
  read: "Read canonical item data chronologically with trimmed text, optionally around a matching item.",
  show: "Expand complete item data through bounded pages. Follow the returned continuation.",
  stats: "Count stored threads, turns, materialised turns and item kinds.",
};

const common = ["threads", "project", "harness", "since", "until", "archived", "settled", "limit", "cursor", "json"] as const;
const itemFilters = ["turn", "kinds", "phase", "tool", "file"] as const;
const matching = ["queries", "excludes", "any", "caseSensitive"] as const;
const recovery = ["opaque", "provider"] as const;

/** The options each action accepts, over CLI flags and MCP input alike. */
const ACTION_FIELDS: Record<Action, readonly TranscriptCommandField[]> = {
  projects: common,
  threads: [...common, ...matching],
  turns: [...common, "turn", "direction"],
  search: [...common, ...itemFilters, ...matching, ...recovery, "direction"],
  read: [...common, ...itemFilters, ...recovery, "direction", "around", "context"],
  show: [...common, "turn", "item", ...recovery],
  stats: [...common, ...itemFilters],
};

type FlagValue = string | number | boolean | string[] | undefined;

/** Undefined leaves a field to its schema default. */
interface FieldReader {
  flag: string;
  kind: "value" | "repeated" | "boolean";
  leadingDash?: boolean;
  read(flags: WorkbenchAgentCommandFlags): FlagValue;
}

function timestamp(value: string | null) {
  if (value === null) return undefined;
  if (/^\d+$/u.test(value)) return Number(value);
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)) throw new Error("Dates must be UTC dates, timezone-qualified ISO timestamps or epoch milliseconds.");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid transcript timestamp.");
  return parsed;
}

function booleanValue(flags: WorkbenchAgentCommandFlags, name: string) {
  const value = flags.optional(name);
  if (value === null) return undefined;
  if (value !== "true" && value !== "false") throw new Error(`${name} requires true or false.`);
  return value === "true";
}

const text = (flag: string, read = (flags: WorkbenchAgentCommandFlags): FlagValue => flags.optional(flag) ?? undefined): FieldReader =>
  ({ flag, kind: "value", read });
const integer = (flag: string) => text(flag, flags => flags.optionalNonNegativeInteger(flag) ?? undefined);
const time = (flag: string) => text(flag, flags => timestamp(flags.optional(flag)));
const toggle = (flag: string) => text(flag, flags => booleanValue(flags, flag));
const repeated = (flag: string, leadingDash = false): FieldReader => ({ flag, kind: "repeated", leadingDash, read: flags => flags.repeated(flag) });
const presence = (flag: string): FieldReader => ({ flag, kind: "boolean", read: flags => flags.has(flag) });

const FIELD_READERS: Record<TranscriptCommandField, FieldReader> = {
  threads: repeated("--thread"), project: text("--project"), harness: text("--harness"), turn: text("--turn"),
  kinds: repeated("--kind"), phase: text("--phase"), tool: text("--tool"), file: text("--file"),
  since: time("--since"), until: time("--until"), archived: toggle("--archived"), settled: toggle("--settled"),
  queries: repeated("--query", true), excludes: repeated("--exclude", true), any: presence("--any"),
  caseSensitive: presence("--case-sensitive"), opaque: presence("--opaque"), item: text("--item"),
  around: text("--around"), context: integer("--context"), limit: integer("--limit"), direction: text("--direction"),
  cursor: text("--cursor"), json: presence("--json"), provider: presence("--provider"),
};

/** Only the action's own fields, still checked against every query rule so mistakes fail before a request is sent. */
function actionSchema(action: Action) {
  const mask = Object.fromEntries(ACTION_FIELDS[action].map(field => [field, true])) as { [Field in TranscriptCommandField]?: true };
  return TranscriptCommandFieldsSchema.pick(mask).superRefine((input, context) => {
    const checked = TranscriptCommandQuerySchema.safeParse({ ...input, action });
    if (!checked.success) for (const issue of checked.error.issues) context.addIssue({ code: "custom", message: issue.message });
  });
}

function readCliFields(action: Action, args: string[]) {
  const readers = ACTION_FIELDS[action].map(field => [field, FIELD_READERS[field]] as const);
  const flagsOf = (kind: FieldReader["kind"]) => readers.flatMap(([, reader]) => reader.kind === kind ? [reader.flag] : []);
  const flags = new WorkbenchAgentCommandFlags(args, {
    values: flagsOf("value"),
    repeatable: flagsOf("repeated"),
    boolean: flagsOf("boolean"),
    leadingDashValues: readers.flatMap(([, reader]) => reader.leadingDash ? [reader.flag] : []),
  });
  return Object.fromEntries(readers.map(([field, reader]) => [field, reader.read(flags)]));
}

export const WORKBENCH_TRANSCRIPT_COMMANDS = TRANSCRIPT_QUERY_ACTIONS.map(action => {
  const inputSchema = actionSchema(action);
  return defineWorkbenchAgentCommand({
    description: DESCRIPTIONS[action],
    effects: { readOnly: true, idempotent: true, openWorld: false },
    helpGroups: ["transcript"],
    mcpDeferred: true,
    managedThreadRootOnly: true,
    words: ["transcript", action],
    usage: `wb transcript ${action}${["read", "show", "turns"].includes(action) ? " --thread <wb-id>" : " [--thread <wb-id>...]"}${action === "search" ? " --query <text>" : ""}${action === "show" ? " --item <id>" : ""} [options]`,
    inputSchema,
    parseCliArgs: args => inputSchema.parse(readCliFields(action, args)),
    buildRequest(input, { callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/internal/transcript", { ...input, action, callerThreadId, cwd });
    },
  });
});
