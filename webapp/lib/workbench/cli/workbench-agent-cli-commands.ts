/*
 * Exports:
 * - WorkbenchAgentCliRequest/WorkbenchAgentCliParseResult: normalized allowlisted CLI request and parse result contracts. Keywords: workbench, cli, request, parse.
 * - WORKBENCH_AGENT_CLI_HELP: complete agent-facing command reference. Keywords: workbench, cli, help, commands.
 * - parseWorkbenchAgentCliCommand: parse one allowlisted wb command into a fixed Workbench request. Keywords: workbench, cli, allowlist, cwd.
 */
import { ORCHESTRATOR_ALL_RELOAD_SCOPES } from "../orchestrator-reload";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WorkbenchAgentCliResponseKind =
  | "browse-command"
  | "browse-session-control"
  | "checkpoint-compare"
  | "checkpoint-create"
  | "checkpoint-proposal"
  | "checkpoint-restore"
  | "json"
  | "native"
  | "orchestrator-reload"
  | "subagent-create"
  | "subagent-list"
  | "subagent-settle"
  | "thread-status"
  | "thread-title";

export interface WorkbenchAgentCliRequest {
  body?: { [key: string]: JsonValue };
  method: "GET" | "POST";
  path: string;
  responseKind: WorkbenchAgentCliResponseKind;
  waitForReload?: boolean;
}

export type WorkbenchAgentCliParseResult =
  | { help: string; kind: "help" }
  | { error: string; kind: "error" }
  | { kind: "request"; request: WorkbenchAgentCliRequest };

interface CommandBuildContext {
  args: string[];
  callerThreadId: string | null;
  cwd: string;
  workbenchOrigin: string | null;
}

interface CommandDefinition {
  aliases?: readonly (readonly string[])[];
  build: (context: CommandBuildContext) => Promise<WorkbenchAgentCliRequest>;
  description: string;
  helpGroups: readonly string[];
  usage: string;
  words: readonly string[];
}

interface HelpGroupDefinition {
  aliases?: readonly (readonly string[])[];
  commandOrder?: readonly string[];
  footer?: string;
  key: string;
  options?: string;
  usage: string;
  words: readonly string[];
}

interface FlagSpec {
  boolean?: readonly string[];
  repeatable?: readonly string[];
  trailing?: boolean;
  values?: readonly string[];
}

class ParsedFlags {
  readonly booleans = new Set<string>();
  readonly trailing: string[];
  readonly values = new Map<string, string[]>();

  constructor(args: string[], spec: FlagSpec) {
    const booleanFlags = new Set(spec.boolean ?? []);
    const repeatableFlags = new Set(spec.repeatable ?? []);
    const valueFlags = new Set([...(spec.values ?? []), ...repeatableFlags]);
    const trailingIndex = args.indexOf("--");
    this.trailing = trailingIndex >= 0 ? args.slice(trailingIndex + 1) : [];
    const optionArgs = trailingIndex >= 0 ? args.slice(0, trailingIndex) : args;
    if (trailingIndex >= 0 && !spec.trailing) {
      throw new Error("This command does not accept trailing arguments after --.");
    }

    for (let index = 0; index < optionArgs.length; index += 1) {
      const flag = optionArgs[index];
      if (!flag.startsWith("--")) {
        throw new Error(`Unexpected argument: ${flag}`);
      }
      if (booleanFlags.has(flag)) {
        this.booleans.add(flag);
        continue;
      }
      if (!valueFlags.has(flag)) {
        throw new Error(`Unsupported option: ${flag}`);
      }
      const value = optionArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value.`);
      }
      index += 1;
      if (!repeatableFlags.has(flag) && this.values.has(flag)) {
        throw new Error(`${flag} may only be supplied once.`);
      }
      this.values.set(flag, [...(this.values.get(flag) ?? []), value]);
    }
  }

  has(flag: string) {
    return this.booleans.has(flag);
  }

  optional(flag: string) {
    return this.values.get(flag)?.[0] ?? null;
  }

  repeated(flag: string) {
    return this.values.get(flag) ?? [];
  }

  required(flag: string) {
    const value = this.optional(flag)?.trim();
    if (!value) {
      throw new Error(`${flag} is required.`);
    }
    return value;
  }

  requiredRepeated(flag: string) {
    const values = this.repeated(flag).map((value) => value.trim());
    if (!values.length || values.some((value) => !value)) {
      throw new Error(`${flag} is required.`);
    }
    if (new Set(values).size !== values.length) {
      throw new Error(`${flag} values must be unique.`);
    }
    return values;
  }

  optionalNonNegativeInteger(flag: string) {
    const value = this.optional(flag);
    if (value === null) {
      return null;
    }
    if (!/^\d+$/u.test(value)) {
      throw new Error(`${flag} must be a non-negative integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`${flag} must be a safe non-negative integer.`);
    }
    return parsed;
  }
}

const THREAD_FLAG = ["--thread"] as const;
const LEGACY_CHECKPOINT_BASELINE_MIGRATION_GUIDE = [
  "wb git checkpoint baseline has been replaced.",
  "",
  "Use the current managed checkpoint workflow:",
  "1. In Brief mode, create the approval checkpoint: wb git checkpoint plan",
  "2. After approval, compare the exact planned paths: wb git checkpoint compare --sha <plan-sha> -- <path> [<path>...]",
  "3. When that drift is safe, create the clean implementation checkpoint: wb git checkpoint implement -- <path> [<path>...]",
  "4. For new clean paths added to the same uncommitted changeset: wb git checkpoint implement --amend <implementation-sha> -- <additional-path> [<additional-path>...]",
  "5. In Review mode, summarize touched paths with: wb git checkpoint compare --sha <implementation-sha> -- <path> [<path>...]",
  "6. Read unified diff content with: wb git checkpoint diff --sha <implementation-sha> -- <path> [<path>...]",
  "7. Propose the frozen-file-set commit with: wb git checkpoint commit --sha <implementation-sha> --m <title> [--m <description>] -- <path> [<path>...]",
  "",
  "Implementation checkpoint paths must be clean. If Workbench rejects dirty paths, stop and ask the user what changed; do not clean or restore them automatically.",
  "Do not use checkpoint create-diff or checkpoint file-diff. This guide reflects the current instructions and CLI.",
  "",
].join("\n");
const RELOAD_SWITCHES = [
  "--orchestrator-logic",
  "--browse-controller",
  "--codex-bridge",
  "--opencode-bridge",
  "--opencode-server",
  "--next-dev",
] as const;

function requireCallerThreadId(callerThreadId: string | null) {
  if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
  return callerThreadId;
}

function preservePowerShellTrailingPaths(args: string[], {
  boolean = [],
  values = ["--worktree"],
}: {
  boolean?: readonly string[];
  values?: readonly string[];
} = {}) {
  if (args.includes("--")) return args;
  for (let index = 0; index < args.length; index += 1) {
    if (values.includes(args[index])) {
      index += 1;
      continue;
    }
    if (boolean.includes(args[index])) continue;
    if (!args[index].startsWith("--")) {
      return [...args.slice(0, index), "--", ...args.slice(index)];
    }
  }
  return args;
}

function queryPath(pathname: string, values: Record<string, string | readonly string[] | null>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      value.filter(Boolean).forEach((entry) => query.append(key, entry));
    } else if (typeof value === "string" && value) {
      query.set(key, value);
    }
  }
  const suffix = query.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}

function post(
  path: string,
  body: WorkbenchAgentCliRequest["body"],
  responseKind: WorkbenchAgentCliResponseKind = "native",
): WorkbenchAgentCliRequest {
  return { body, method: "POST", path, responseKind };
}

function get(path: string, responseKind: WorkbenchAgentCliResponseKind = "native"): WorkbenchAgentCliRequest {
  return { method: "GET", path, responseKind };
}

function parseVariables(values: string[]) {
  const variables: Record<string, JsonValue> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    const key = separator > 0 ? value.slice(0, separator).trim() : "";
    if (!key) {
      throw new Error(`Browse variable must use key=value syntax: ${value}`);
    }
    variables[key] = value.slice(separator + 1);
  }
  return variables;
}

function readSubagentTargets(flags: ParsedFlags) {
  const threadIds = flags.repeated("--id").map((value) => value.trim());
  const names = flags.repeated("--name").map((value) => value.trim());
  if (!threadIds.length && !names.length) throw new Error("At least one --id or --name target is required.");
  if (threadIds.some((value) => !value) || names.some((value) => !value)) throw new Error("Subagent targets cannot be empty.");
  if (new Set(threadIds).size !== threadIds.length) throw new Error("--id values must be unique.");
  if (new Set(names.map((value) => value.toLocaleLowerCase())).size !== names.length) throw new Error("--name values must be unique ignoring case.");
  return {
    ...(names.length ? { names } : {}),
    ...(threadIds.length ? { threadIds } : {}),
  };
}

const COMMANDS: readonly CommandDefinition[] = [
  {
    description: "List unsettled direct children, or settled history.",
    helpGroups: ["subagent"],
    words: ["subagent", "list"],
    usage: "wb subagent list [--settled [--cursor <cursor>] [--limit <1-20>]]",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(args, { boolean: ["--settled"], values: ["--cursor", "--limit"] });
      if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
      const limit = flags.optionalNonNegativeInteger("--limit");
      if (limit !== null && (limit < 1 || limit > 20)) throw new Error("--limit must be between 1 and 20.");
      if (!flags.has("--settled") && (flags.optional("--cursor") || limit !== null)) throw new Error("--cursor and --limit require --settled.");
      return post("/api/subagents", {
        action: "list", callerThreadId, cwd, settled: flags.has("--settled"),
        ...(flags.optional("--cursor") ? { cursor: flags.optional("--cursor")! } : {}),
        ...(limit !== null ? { limit } : {}),
      }, "subagent-list");
    },
  },
  {
    description: "List the subagent profiles available to this thread.",
    helpGroups: ["subagent"],
    words: ["subagent", "profiles"],
    usage: "wb subagent profiles",
    async build({ args, callerThreadId, cwd, workbenchOrigin }) {
      new ParsedFlags(args, {});
      if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
      return post("/api/subagents", { action: "profiles", callerThreadId, cwd, ...(workbenchOrigin ? { workbenchOrigin } : {}) }, "json");
    },
  },
  {
    description: "Create and start a direct child, then print its thread ID.",
    helpGroups: ["subagent"],
    words: ["subagent", "create"],
    usage: "wb subagent create --profile <profile-id> --name <name> --title <title> --message <message>",
    async build({ args, callerThreadId, cwd, workbenchOrigin }) {
      const flags = new ParsedFlags(args, { values: ["--profile", "--name", "--title", "--message"] });
      if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
      return post("/api/subagents", {
        action: "create", callerThreadId, cwd, message: flags.required("--message"), name: flags.required("--name"),
        profileId: flags.required("--profile"), title: flags.required("--title"), ...(workbenchOrigin ? { workbenchOrigin } : {}),
      }, "subagent-create");
    },
  },
  {
    description: "Wait until any selected child needs attention or reaches a terminal state.",
    helpGroups: ["subagent"],
    words: ["subagent", "wait"],
    usage: "wb subagent wait (--id <id> | --name <name>) [...]",
    async build({ args, callerThreadId, cwd, workbenchOrigin }) {
      const flags = new ParsedFlags(args, { repeatable: ["--id", "--name"] });
      if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
      return post("/api/subagents", {
        action: "wait", callerThreadId, cwd, ...readSubagentTargets(flags), ...(workbenchOrigin ? { workbenchOrigin } : {}),
      });
    },
  },
  {
    description: "Stop one or more direct child threads.",
    helpGroups: ["subagent"],
    words: ["subagent", "stop"],
    usage: "wb subagent stop (--id <id> | --name <name>) [...]",
    async build({ args, callerThreadId, cwd, workbenchOrigin }) {
      const flags = new ParsedFlags(args, { repeatable: ["--id", "--name"] });
      if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
      return post("/api/subagents", {
        action: "stop", callerThreadId, cwd, ...readSubagentTargets(flags), ...(workbenchOrigin ? { workbenchOrigin } : {}),
      });
    },
  },
  {
    description: "Settle one or more completed or stopped direct children.",
    helpGroups: ["subagent"],
    words: ["subagent", "settle"],
    usage: "wb subagent settle (--id <id> | --name <name>) [...]",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(args, { repeatable: ["--id", "--name"] });
      return post("/api/subagents", { action: "settle", callerThreadId: requireCallerThreadId(callerThreadId), cwd, ...readSubagentTargets(flags) }, "subagent-settle");
    },
  },
  {
    description: "Message a direct child or parent, steering an active turn or starting an idle one.",
    helpGroups: ["subagent"],
    words: ["subagent", "message"],
    usage: "wb subagent message (--id <id> | --name <name> | --parent) --message <message>",
    async build({ args, callerThreadId, cwd, workbenchOrigin }) {
      const flags = new ParsedFlags(args, { boolean: ["--parent"], values: ["--id", "--name", "--message"] });
      if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
      const threadId = flags.optional("--id")?.trim() ?? "";
      const name = flags.optional("--name")?.trim() ?? "";
      const parent = flags.has("--parent");
      if ([Boolean(threadId), Boolean(name), parent].filter(Boolean).length !== 1) throw new Error("Exactly one of --id, --name, or --parent is required.");
      return post("/api/subagents", {
        action: "message", callerThreadId, cwd, message: flags.required("--message"),
        ...(parent ? { parent: true } : threadId ? { threadId } : { name }),
        ...(workbenchOrigin ? { workbenchOrigin } : {}),
      });
    },
  },
  {
    description: "Set a concise title for a managed thread.",
    helpGroups: ["thread"],
    words: ["thread", "title"],
    usage: "wb thread title --title <text>",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(args, { values: ["--title"] });
      return post("/api/thread-title", { callerThreadId: requireCallerThreadId(callerThreadId), cwd, title: flags.required("--title") }, "thread-title");
    },
  },
  {
    description: "Set the exact current turn status for this managed thread.",
    helpGroups: ["thread"],
    words: ["thread", "status"],
    usage: "wb thread status --status <completed|blocked>",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(args, { values: ["--status"] });
      const status = flags.required("--status");
      if (status !== "completed" && status !== "blocked") throw new Error("--status must be completed or blocked.");
      return post("/api/thread-status", { callerThreadId: requireCallerThreadId(callerThreadId), cwd, status }, "thread-status");
    },
  },
  {
    aliases: [["thread", "context", "search"]],
    description: "Search visible narrative history and return stable result references.",
    helpGroups: ["thread", "thread-recall"],
    words: ["thread", "recall", "search"],
    usage: "wb thread recall search --thread <id> --query <text> [--kind <kind>...] [--limit <count>] [--before <ref>]",
    async build({ args }) {
      const flags = new ParsedFlags(args, {
        repeatable: ["--kind"],
        values: [...THREAD_FLAG, "--query", "--limit", "--before"],
      });
      const kinds = flags.repeated("--kind");
      const limit = flags.optionalNonNegativeInteger("--limit");
      if (limit !== null && (limit < 1 || limit > 50)) throw new Error("--limit must be between 1 and 50.");
      return post(`/api/thread-context/${encodeURIComponent(flags.required("--thread"))}`, {
        action: "search",
        query: flags.required("--query"),
        ...(kinds.length ? { kinds } : {}),
        ...(limit !== null ? { limit } : {}),
        ...(flags.optional("--before") ? { before: flags.optional("--before") } : {}),
      });
    },
  },
  {
    aliases: [["thread", "context", "expand"]],
    description: "Read one referenced record through fixed-budget content pages.",
    helpGroups: ["thread", "thread-recall"],
    words: ["thread", "recall", "expand"],
    usage: "wb thread recall expand --thread <id> --ref <ref> [--cursor <cursor>]",
    async build({ args }) {
      const flags = new ParsedFlags(args, { values: [...THREAD_FLAG, "--ref", "--cursor"] });
      return post(`/api/thread-context/${encodeURIComponent(flags.required("--thread"))}`, {
        action: "expand",
        ref: flags.required("--ref"),
        ...(flags.optional("--cursor") ? { cursor: flags.optional("--cursor") } : {}),
      });
    },
  },
  {
    aliases: [["thread", "context"]],
    description: "Read filtered history newest-first, or continue before an emitted cursor.",
    helpGroups: ["thread", "thread-recall"],
    words: ["thread", "recall"],
    usage: "wb thread recall --thread <id> [--kind <kind>...] [--before <cursor>]",
    async build({ args }) {
      const flags = new ParsedFlags(args, { repeatable: ["--kind"], values: [...THREAD_FLAG, "--before"] });
      const threadId = flags.required("--thread");
      return get(queryPath(`/api/thread-context/${encodeURIComponent(threadId)}`, {
        before: flags.optional("--before"),
        kind: flags.repeated("--kind"),
      }));
    },
  },
  ...(["add", "unstage"] as const).map((action): CommandDefinition => ({
    description: action === "add"
      ? "Add currently changed files beneath the paths to this thread's commit selection."
      : "Remove exact files or descendants from this thread's commit selection.",
    helpGroups: ["git"],
    words: ["git", action],
    usage: `wb git ${action} [--worktree <absolute-path>] -- <path> [<path>...]`,
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(preservePowerShellTrailingPaths(args), { trailing: true, values: ["--worktree"] });
      if (!flags.trailing.length) throw new Error(`wb git ${action} requires at least one path.`);
      const targetWorktree = flags.optional("--worktree");
      return post("/api/git", {
        action,
        cwd,
        paths: flags.trailing,
        ...(targetWorktree ? { targetWorktree } : {}),
        threadId: requireCallerThreadId(callerThreadId),
      });
    },
  })),
  {
    description: "Commit only this thread's selected files, then clear the selection on success.",
    helpGroups: ["git"],
    words: ["git", "commit"],
    usage: "wb git commit [--worktree <absolute-path>] --message <message>",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(args, { values: ["--message", "--worktree"] });
      const targetWorktree = flags.optional("--worktree");
      return post("/api/git", {
        action: "commit",
        cwd,
        message: flags.required("--message"),
        ...(targetWorktree ? { targetWorktree } : {}),
        threadId: requireCallerThreadId(callerThreadId),
      });
    },
  },
  {
    aliases: [["checkpoint", "plan"]],
    description: "Capture the current worktree as a hidden plan checkpoint.",
    helpGroups: ["git-checkpoint"],
    words: ["git", "checkpoint", "plan"],
    usage: "wb git checkpoint plan",
    async build({ args, callerThreadId, cwd }) {
      new ParsedFlags(args, {});
      return post("/api/git-checkpoint", {
        action: "plan",
        cwd,
        threadId: requireCallerThreadId(callerThreadId),
      }, "checkpoint-create");
    },
  },
  {
    aliases: [["checkpoint", "implement"]],
    description: "Capture a clean path-scoped implementation checkpoint, or extend an existing implementation scope.",
    helpGroups: ["git-checkpoint"],
    words: ["git", "checkpoint", "implement"],
    usage: "wb git checkpoint implement [--amend <sha>] -- <path> [<path>...]",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(preservePowerShellTrailingPaths(args, {
        values: ["--amend"],
      }), { trailing: true, values: ["--amend"] });
      if (!flags.trailing.length) throw new Error("Implementation checkpoint paths are required after --.");
      return post("/api/git-checkpoint", {
        action: "implement",
        ...(flags.optional("--amend") ? { amendCheckpoint: flags.optional("--amend")! } : {}),
        cwd,
        paths: flags.trailing,
        threadId: requireCallerThreadId(callerThreadId),
      }, "checkpoint-create");
    },
  },
  {
    aliases: [["checkpoint", "compare"]],
    description: "Show per-file change counts for selected checkpoint paths.",
    helpGroups: ["git-checkpoint"],
    words: ["git", "checkpoint", "compare"],
    usage: "wb git checkpoint compare --sha <sha> -- <path> [<path>...]",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(preservePowerShellTrailingPaths(args, { values: ["--sha"] }), {
        trailing: true,
        values: ["--sha"],
      });
      if (!flags.trailing.length) throw new Error("Checkpoint compare paths are required after --.");
      return post("/api/git-checkpoint", {
        action: "compare",
        checkpointCommit: flags.required("--sha"),
        cwd,
        paths: flags.trailing,
        threadId: requireCallerThreadId(callerThreadId),
      }, "checkpoint-compare");
    },
  },
  {
    aliases: [["checkpoint", "diff"]],
    description: "Show unified diff content for selected checkpoint paths.",
    helpGroups: ["git-checkpoint"],
    words: ["git", "checkpoint", "diff"],
    usage: "wb git checkpoint diff --sha <sha> -- <path> [<path>...]",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(preservePowerShellTrailingPaths(args, { values: ["--sha"] }), {
        trailing: true,
        values: ["--sha"],
      });
      if (!flags.trailing.length) throw new Error("Checkpoint diff paths are required after --.");
      return post("/api/git-checkpoint", {
        action: "diff",
        checkpointCommit: flags.required("--sha"),
        cwd,
        paths: flags.trailing,
        threadId: requireCallerThreadId(callerThreadId),
      });
    },
  },
  {
    aliases: [["checkpoint", "commit"]],
    description: "Create a durable editable commit proposal for selected checkpoint paths.",
    helpGroups: ["git-checkpoint"],
    words: ["git", "checkpoint", "commit"],
    usage: "wb git checkpoint commit --sha <sha> --m <title> [--m <description>] -- <path> [<path>...]",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(preservePowerShellTrailingPaths(args, { values: ["--sha", "--m"] }), {
        repeatable: ["--m"],
        trailing: true,
        values: ["--sha"],
      });
      if (!flags.trailing.length) throw new Error("Checkpoint commit paths are required after --.");
      const messages = flags.requiredRepeated("--m");
      if (messages.length > 2) throw new Error("Checkpoint commit accepts at most two --m values.");
      return post("/api/git-checkpoint", {
        action: "proposalCreate",
        checkpointCommit: flags.required("--sha"),
        cwd,
        description: messages[1] ?? "",
        paths: flags.trailing,
        threadId: requireCallerThreadId(callerThreadId),
        title: messages[0],
      }, "checkpoint-proposal");
    },
  },
  {
    aliases: [["checkpoint", "restore"]],
    description: "Restore selected paths from a checkpoint, or restore the full checkpoint after explicit confirmation.",
    helpGroups: ["git-checkpoint"],
    words: ["git", "checkpoint", "restore"],
    usage: "wb git checkpoint restore --commit <sha> (--confirm | -- <path> [<path>...])",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(preservePowerShellTrailingPaths(args, {
        boolean: ["--confirm"],
        values: ["--commit"],
      }), { boolean: ["--confirm"], trailing: true, values: ["--commit"] });
      if (!flags.trailing.length && !flags.has("--confirm")) {
        throw new Error("Full checkpoint restore requires --confirm; otherwise provide paths after --.");
      }
      return post("/api/git-checkpoint", {
        action: "restore",
        checkpointCommit: flags.required("--commit"),
        ...(flags.has("--confirm") ? { confirmRestore: true } : {}),
        cwd,
        ...(flags.trailing.length ? { paths: flags.trailing } : {}),
        threadId: requireCallerThreadId(callerThreadId),
      }, "checkpoint-restore");
    },
  },
  {
    description: "Run inline BrowseMD commands or one project BrowseMD script.",
    helpGroups: ["browse"],
    words: ["browse", "run"],
    usage: "wb browse run --thread <id> [--session <name>] (--command <line>... | --script-path <file>) [--var <key=value>...] [--summary <text>]",
    async build({ args, cwd }) {
      const flags = new ParsedFlags(args, {
        repeatable: ["--command", "--var"],
        values: [...THREAD_FLAG, "--session", "--script-path", "--summary"],
      });
      const commands = flags.repeated("--command");
      const scriptPath = flags.optional("--script-path");
      if ((!commands.length && !scriptPath) || (commands.length && scriptPath)) {
        throw new Error("Browse run requires either repeated --command values or one --script-path.");
      }
      const variables = parseVariables(flags.repeated("--var"));
      return post("/api/browse", {
        cwd,
        ...(commands.length ? { script: commands.join("\n") } : { scriptPath: scriptPath as string }),
        ...(flags.optional("--session") ? { session: flags.optional("--session") as string } : {}),
        ...(flags.optional("--summary") ? { summary: flags.optional("--summary") as string } : {}),
        ...(Object.keys(variables).length ? { vars: variables } : {}),
        threadId: flags.required("--thread"),
      }, "browse-command");
    },
  },
  {
    description: "Run the explicitly gated raw Browse CLI passthrough.",
    helpGroups: ["browse"],
    words: ["browse", "raw"],
    usage: "wb browse raw --thread <id> -- <Browse CLI args>",
    async build({ args, cwd }) {
      const flags = new ParsedFlags(args, { trailing: true, values: THREAD_FLAG });
      if (!flags.trailing.length) {
        throw new Error("Browse raw requires Browse CLI arguments after --.");
      }
      return post("/api/browse", {
        args: flags.trailing,
        cwd,
        threadId: flags.required("--thread"),
      }, "browse-command");
    },
  },
  {
    description: "List Workbench-known browser sessions for the thread.",
    helpGroups: ["browse"],
    words: ["browse", "sessions"],
    usage: "wb browse sessions --thread <id>",
    async build({ args, cwd }) {
      const flags = new ParsedFlags(args, { values: THREAD_FLAG });
      return get(queryPath("/api/browse/sessions", { cwd, threadId: flags.required("--thread") }), "json");
    },
  },
  ...(["stop", "forget"] as const).map((action): CommandDefinition => ({
    description: action === "stop"
      ? "Stop a browser session without deleting persistent profile data."
      : "Forget a stopped session and delete its persistent profile data.",
    helpGroups: ["browse"],
    words: ["browse", action],
    usage: `wb browse ${action} --thread <id> --session <name>${action === "stop" ? " [--force]" : ""}`,
    async build({ args, cwd }) {
      const flags = new ParsedFlags(args, {
        boolean: action === "stop" ? ["--force"] : [],
        values: [...THREAD_FLAG, "--session"],
      });
      return post("/api/browse/sessions", {
        action,
        cwd,
        ...(action === "stop" && flags.has("--force") ? { force: true } : {}),
        session: flags.required("--session"),
        threadId: flags.required("--thread"),
      }, "browse-session-control");
    },
  })),
  {
    description: "Reload selected Workbench runtime subsystems and wait for terminal reload status.",
    helpGroups: ["orchestrator"],
    words: ["orchestrator", "reload"],
    usage: "wb orchestrator reload [--all] [--orchestrator-logic] [--browse-controller] [--codex-bridge] [--opencode-bridge] [--opencode-server] [--next-dev]",
    async build({ args }) {
      const flags = new ParsedFlags(args, { boolean: [...RELOAD_SWITCHES, "--all", "--hard"] });
      const selectedOrdinaryFlags = RELOAD_SWITCHES.filter((flag) => flags.has(flag));
      if (flags.has("--hard") && (flags.has("--all") || selectedOrdinaryFlags.length)) {
        throw new Error("--hard must be requested by itself.");
      }
      const scopes = flags.has("--hard")
        ? ["orchestrator-server"]
        : Array.from(new Set([
          ...(flags.has("--all") ? ORCHESTRATOR_ALL_RELOAD_SCOPES : []),
          ...selectedOrdinaryFlags.map((flag) => flag.slice(2)),
        ]));
      if (!scopes.length) {
        throw new Error("Orchestrator reload requires at least one reload switch.");
      }
      return {
        ...post("/api/orchestrator/reload", { scopes }, "orchestrator-reload"),
        waitForReload: true,
      };
    },
  },
];

const ROOT_HELP_COMMAND_ORDER = [
  "subagent list",
  "subagent profiles",
  "subagent create",
  "subagent wait",
  "subagent stop",
  "subagent message",
  "thread title",
  "thread recall",
  "thread recall search",
  "thread recall expand",
  "git add",
  "git unstage",
  "git commit",
  "git checkpoint plan",
  "git checkpoint implement",
  "git checkpoint compare",
  "git checkpoint diff",
  "git checkpoint commit",
  "git checkpoint restore",
  "browse run",
  "browse raw",
  "browse sessions",
  "browse stop",
  "browse forget",
  "orchestrator reload",
] as const;

const HELP_GROUPS: readonly HelpGroupDefinition[] = [
  {
    commandOrder: ["subagent list", "subagent profiles", "subagent create", "subagent wait", "subagent message", "subagent stop"],
    footer: [
      "The current managed thread is always the parent.",
      "Run commands from the intended project working directory.",
    ].join("\n"),
    key: "subagent",
    usage: "wb subagent <command> [options]",
    words: ["subagent"],
  },
  {
    commandOrder: ["thread title", "thread recall", "thread recall search", "thread recall expand"],
    key: "thread",
    usage: "wb thread <command> [options]",
    words: ["thread"],
  },
  {
    aliases: [["thread", "context"]],
    commandOrder: ["thread recall", "thread recall search", "thread recall expand"],
    footer: [
      "Kinds: user-message, user-steer, questionnaire, commentary, final-answer, agent-message, plan.",
      "Recall excludes reasoning, raw commands, tool output, Browse data, hooks, and compaction markers.",
      "Run one recall command at a time and follow the exact continuation command emitted by the current page.",
    ].join("\n"),
    key: "thread-recall",
    usage: "wb thread recall [command] [options]",
    words: ["thread", "recall"],
  },
  {
    commandOrder: ["git add", "git unstage", "git commit"],
    footer: [
      "Run from the repository root and use . with add to select all changed files.",
      "Run from the repository root and use . with unstage to clear the thread selection.",
      "Use --worktree with an absolute registered worktree path while keeping the command cwd as the control-plane project.",
      "Git commands derive the current managed thread ID from Workbench caller context.",
      "Unrelated files in the ordinary Git index remain outside the thread-owned commit.",
    ].join("\n"),
    key: "git",
    usage: "wb git <command> [options]",
    words: ["git"],
  },
  {
    aliases: [["checkpoint"]],
    commandOrder: [
      "git checkpoint plan",
      "git checkpoint implement",
      "git checkpoint compare",
      "git checkpoint diff",
      "git checkpoint commit",
      "git checkpoint restore",
    ],
    footer: [
      "Pass paths after -- to restore only those files or directories from the checkpoint.",
      "Use --confirm without paths only when the user explicitly requested a full checkpoint restore.",
    ].join("\n"),
    key: "git-checkpoint",
    usage: "wb git checkpoint <command> [options]",
    words: ["git", "checkpoint"],
  },
  {
    commandOrder: ["browse run", "browse sessions", "browse stop", "browse forget", "browse raw"],
    footer: [
      "Use the /browse skill for browser workflow, sequencing, screenshots, and cleanup.",
      "Raw passthrough is unavailable unless Workbench explicitly enables it.",
      "Each wb browse call must contain only one BrowseMD run, raw invocation, or session command.",
    ].join("\n"),
    key: "browse",
    usage: "wb browse <command> [options]",
    words: ["browse"],
  },
  {
    key: "orchestrator",
    options: [
      "Options:",
      "  --all                 Reload all non-destructive orchestrator scopes: orchestrator-logic, browse-controller, codex-bridge, opencode-bridge, next-dev.",
      "  --orchestrator-logic  Reload declared orchestrator modules.",
      "  --browse-controller   Drain and replace Browse controller code without restarting browser sessions.",
      "  --codex-bridge        Reload Codex bridge code without restarting the stable Codex app-server.",
      "  --opencode-bridge     Reload OpenCode bridge code.",
      "  --opencode-server     Restart the managed OpenCode server.",
      "  --next-dev            Restart the Next.js development server.",
    ].join("\n"),
    footer: [
      "At least one option is required.",
      "Use the narrowest applicable scope.",
    ].join("\n"),
    usage: "wb orchestrator reload [--all] [--orchestrator-logic] [--browse-controller] [--codex-bridge] [--opencode-bridge] [--opencode-server] [--next-dev]",
    words: ["orchestrator"],
  },
];

function commandKey(command: CommandDefinition) {
  return command.words.join(" ");
}

function orderCommands(commands: readonly CommandDefinition[], order: readonly string[]) {
  const indexes = new Map(order.map((key, index) => [key, index]));
  return [...commands].sort((left, right) => (
    (indexes.get(commandKey(left)) ?? Number.MAX_SAFE_INTEGER)
    - (indexes.get(commandKey(right)) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function renderRootHelp() {
  const commands = orderCommands(COMMANDS, ROOT_HELP_COMMAND_ORDER);
  const helpGroups = HELP_GROUPS.filter((group) => COMMANDS.some((command) => command.helpGroups.includes(group.key)));
  return [
    "Usage:",
    "  wb --help",
    "  wb <command> [options]",
    "",
    "Commands:",
    ...commands.map((command) => `  ${command.usage}`),
    "",
    "Help commands:",
    ...helpGroups.map((group) => `  wb ${group.words.join(" ")} --help`),
    "",
    "Project ownership is derived from the current working directory.",
    "",
  ].join("\n");
}

function renderGroupHelp(group: HelpGroupDefinition) {
  const commands = orderCommands(
    COMMANDS.filter((command) => command.helpGroups.includes(group.key)),
    group.commandOrder ?? [],
  );
  const commandSection = group.options
    ? group.options
    : [
      "Commands:",
      ...commands.flatMap((command, index) => [
        ...(index ? [""] : []),
        `  ${command.usage}`,
        `    ${command.description}`,
      ]),
    ].join("\n");
  return [
    "Usage:",
    `  ${group.usage}`,
    "",
    commandSection,
    ...(group.footer ? ["", group.footer] : []),
    "",
  ].join("\n");
}

function matchesWords(argv: readonly string[], words: readonly string[]) {
  return words.every((word, index) => argv[index] === word);
}

function matchHelpGroup(argv: readonly string[]) {
  return HELP_GROUPS.flatMap((group) => (
    [group.words, ...(group.aliases ?? [])].map((words) => ({ group, words }))
  ))
    .filter((candidate) => matchesWords(argv, candidate.words))
    .sort((left, right) => right.words.length - left.words.length)[0]?.group ?? null;
}

function helpPath(argv: readonly string[]) {
  if (argv[0] === "help") {
    return [];
  }
  return argv.filter((argument) => argument !== "--help");
}

export const WORKBENCH_AGENT_CLI_HELP = renderRootHelp();

export async function parseWorkbenchAgentCliCommand(
  argv: string[],
  {
    cwd = process.cwd(),
    callerThreadId = process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim() || null,
    workbenchOrigin = process.env.WORKBENCH_ORIGIN?.trim() || null,
  }: {
    callerThreadId?: string | null;
    cwd?: string;
    workbenchOrigin?: string | null;
  } = {},
): Promise<WorkbenchAgentCliParseResult> {
  const isLegacyCheckpointBaseline = (
    argv.length === 3
    && argv[0] === "git"
    && argv[1] === "checkpoint"
    && argv[2] === "baseline"
  ) || (
    argv.length === 2
    && argv[0] === "checkpoint"
    && argv[1] === "baseline"
  );
  if (isLegacyCheckpointBaseline) {
    return { help: LEGACY_CHECKPOINT_BASELINE_MIGRATION_GUIDE, kind: "help" };
  }

  if (!argv.length || argv.includes("--help") || argv[0] === "help") {
    const group = matchHelpGroup(helpPath(argv));
    return { help: group ? renderGroupHelp(group) : renderRootHelp(), kind: "help" };
  }

  const matched = COMMANDS.flatMap((definition) => (
    [definition.words, ...(definition.aliases ?? [])].map((words) => ({ definition, words }))
  ))
    .filter((candidate) => matchesWords(argv, candidate.words))
    .sort((left, right) => right.words.length - left.words.length)[0];
  if (!matched) {
    return { error: `Unsupported wb command: ${argv.join(" ")}\n\n${WORKBENCH_AGENT_CLI_HELP}`, kind: "error" };
  }

  try {
    return {
      kind: "request",
      request: await matched.definition.build({ args: argv.slice(matched.words.length), callerThreadId, cwd, workbenchOrigin }),
    };
  } catch (error) {
    return {
      error: `${error instanceof Error ? error.message : String(error)}\n\nUsage: ${matched.definition.usage}`,
      kind: "error",
    };
  }
}
