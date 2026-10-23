/*
 * Exports:
 * - WORKBENCH_TRANSCRIPT_COMMANDS: deferred stored-history discovery, search and reading; each action's CLI options and tool schema come from one field table.
 */
import {
  HISTORY_QUERY_ACTIONS,
  HistoryCommandFieldsSchema,
  HistoryCommandQuerySchema,
  type HistoryCommandField,
  type HistoryCommandQuery,
} from "../../../database/history/history-query-contract";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

type Action = HistoryCommandQuery["action"];

const DESCRIPTIONS: Record<Action, string> = {
  projects: "List stored transcript projects, roots and thread counts.",
  threads: "Find stored threads by title words and metadata. Returned ids are Workbench thread ids.",
  turns: "List a Workbench thread's turns and stored-body coverage.",
  search: "Rank indexed transcript items across projects or exact --thread ids: words in any order, \"quoted phrases\", -exclusions. No provider reads.",
  read: "Read canonical item data chronologically with trimmed text, newest page or --before/--after/--around an item id.",
  show: "Expand complete item data through bounded pages. Follow the returned continuation.",
  stats: "Count stored threads, turns, materialised turns and item kinds.",
};

const common = ["threads", "project", "harness", "since", "until", "archived", "settled", "json"] as const;
const itemFilters = ["turn", "kinds", "phase", "tool", "file"] as const;
const recovery = ["opaque", "provider"] as const;

/** The options each action accepts, over CLI flags and MCP input alike. */
const ACTION_FIELDS: Record<Action, readonly HistoryCommandField[]> = {
  projects: [...common, "limit", "cursor"],
  threads: [...common, "query", "limit", "cursor"],
  turns: [...common, "turn", "limit", "cursor"],
  search: [...common, ...itemFilters, ...recovery, "query", "limit", "cursor"],
  read: [...common, ...itemFilters, ...recovery, "before", "after", "around", "context", "limit"],
  show: [...common, "turn", "item", ...recovery, "cursor"],
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
const repeated = (flag: string): FieldReader => ({ flag, kind: "repeated", read: flags => flags.repeated(flag) });
const presence = (flag: string): FieldReader => ({ flag, kind: "boolean", read: flags => flags.has(flag) });
/** Repeated --query values join into one query, so `--query a --query -b` reads as `a -b`. */
const joinedQuery: FieldReader = {
  flag: "--query", kind: "repeated", leadingDash: true,
  read: flags => flags.repeated("--query").join(" ") || undefined,
};

const FIELD_READERS: Record<Exclude<HistoryCommandField, "view">, FieldReader> = {
  threads: repeated("--thread"), project: text("--project"), harness: text("--harness"), turn: text("--turn"),
  kinds: repeated("--kind"), phase: text("--phase"), tool: text("--tool"), file: text("--file"),
  since: time("--since"), until: time("--until"), archived: toggle("--archived"), settled: toggle("--settled"),
  query: joinedQuery, opaque: presence("--opaque"), item: text("--item"),
  before: text("--before"), after: text("--after"), around: text("--around"), context: integer("--context"),
  limit: integer("--limit"), cursor: text("--cursor"), json: presence("--json"), provider: presence("--provider"),
};

/** Only the action's own fields, still checked against every query rule so mistakes fail before a request is sent. */
function actionSchema(action: Action) {
  const mask = Object.fromEntries(ACTION_FIELDS[action].map(field => [field, true])) as { [Field in HistoryCommandField]?: true };
  return HistoryCommandFieldsSchema.pick(mask).superRefine((input, context) => {
    const checked = HistoryCommandQuerySchema.safeParse({ ...input, action });
    if (!checked.success) for (const issue of checked.error.issues) context.addIssue({ code: "custom", message: issue.message });
  });
}

function readCliFields(action: Action, args: string[]) {
  const readers = ACTION_FIELDS[action].map(field => [field, FIELD_READERS[field as Exclude<HistoryCommandField, "view">]] as const);
  const flagsOf = (kind: FieldReader["kind"]) => readers.flatMap(([, reader]) => reader.kind === kind ? [reader.flag] : []);
  const flags = new WorkbenchAgentCommandFlags(args, {
    values: flagsOf("value"),
    repeatable: flagsOf("repeated"),
    boolean: flagsOf("boolean"),
    leadingDashValues: readers.flatMap(([, reader]) => reader.leadingDash ? [reader.flag] : []),
  });
  return Object.fromEntries(readers.map(([field, reader]) => [field, reader.read(flags)]));
}

const USAGE: Record<Action, string> = {
  projects: "",
  threads: " [--query <title words>]",
  turns: " --thread <wb-id>",
  search: " [--thread <wb-id>...] --query <words, \"phrases\", -exclusions>",
  read: " --thread <wb-id> [--before|--after|--around <item-id>]",
  show: " --thread <wb-id> --item <item-id>",
  stats: "",
};

export const WORKBENCH_TRANSCRIPT_COMMANDS = HISTORY_QUERY_ACTIONS.map(action => {
  const inputSchema = actionSchema(action);
  return defineWorkbenchAgentCommand({
    description: DESCRIPTIONS[action],
    effects: { readOnly: true, idempotent: true, openWorld: false },
    helpGroups: ["transcript"],
    mcpDeferred: true,
    audience: { rootOnly: true },
    words: ["transcript", action],
    usage: `wb transcript ${action}${USAGE[action]} [options]`,
    inputSchema,
    parseCliArgs: args => inputSchema.parse(readCliFields(action, args)),
    buildRequest(input, { callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/internal/transcript", { ...input, action, callerThreadId, cwd });
    },
  });
});
