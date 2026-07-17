/*
 * Exports:
 * - WorkbenchAgentCliRequest/WorkbenchAgentCliParseResult: normalized allowlisted CLI request and parse result contracts. Keywords: workbench, cli, request, parse.
 * - WorkbenchAgentCliThreadHelpAudience/WorkbenchAgentCliCapabilitiesRequest/WorkbenchAgentCliCapabilitiesResponse: thread-aware help capability contracts. Keywords: workbench, cli, help, audience, capabilities.
 * - WORKBENCH_AGENT_CLI_HELP: complete agent-facing command reference. Keywords: workbench, cli, help, commands.
 * - parseWorkbenchAgentCliCommand: parse one allowlisted wb command into a fixed Workbench request. Keywords: workbench, cli, allowlist, cwd.
 */
import { readFile } from "node:fs/promises";

import { ORCHESTRATOR_ALL_RELOAD_SCOPES } from "../orchestrator-reload";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WorkbenchAgentCliResponseKind =
  | "browse-command"
  | "browse-session-control"
  | "checkpoint-create"
  | "checkpoint-restore"
  | "collaboration-memory-read"
  | "collaboration-memory-write"
  | "collaboration-post-mutation"
  | "json"
  | "native"
  | "orchestrator-reload"
  | "subagent-create"
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

export type WorkbenchAgentCliThreadHelpAudience = "collaborator" | "default";

export interface WorkbenchAgentCliCapabilitiesRequest {
  cwd: string;
  threadId: string;
}

export interface WorkbenchAgentCliCapabilitiesResponse {
  helpAudience: WorkbenchAgentCliThreadHelpAudience;
}

interface CommandBuildContext {
  args: string[];
  callerThreadId: string | null;
  cwd: string;
  readTextFile: (filePath: string) => Promise<string>;
  workbenchOrigin: string | null;
}

interface CommandDefinition {
  aliases?: readonly (readonly string[])[];
  audiences: readonly WorkbenchAgentCliThreadHelpAudience[];
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
const DEFAULT_HELP_AUDIENCE = ["default"] as const;
const SHARED_HELP_AUDIENCES = ["default", "collaborator"] as const;
const COLLABORATOR_HELP_AUDIENCE = ["collaborator"] as const;
const RELOAD_SWITCHES = [
  "--orchestrator-logic",
  "--browse-controller",
  "--codex-bridge",
  "--opencode-bridge",
  "--opencode-server",
  "--next-dev",
] as const;

function readOwnedThreadId(flags: ParsedFlags, callerThreadId: string | null) {
  if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
  const threadId = flags.required("--thread");
  if (threadId !== callerThreadId) throw new Error("Git operations must use the current managed Workbench thread id.");
  return threadId;
}

function preservePowerShellTrailingPaths(args: string[]) {
  if (args.includes("--")) return args;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--thread") {
      index += 1;
      continue;
    }
    if (!args[index].startsWith("--")) {
      return [...args.slice(0, index), "--", ...args.slice(index)];
    }
  }
  return args;
}

async function readLiteralOrFile(
  flags: ParsedFlags,
  literalFlag: string,
  fileFlag: string,
  readTextFile: CommandBuildContext["readTextFile"],
  { required = false }: { required?: boolean } = {},
) {
  const literal = flags.optional(literalFlag);
  const filePath = flags.optional(fileFlag);
  if (literal !== null && filePath !== null) {
    throw new Error(`${literalFlag} and ${fileFlag} are mutually exclusive.`);
  }
  if (literal !== null) {
    return literal;
  }
  if (filePath !== null) {
    return await readTextFile(filePath);
  }
  if (required) {
    throw new Error(`${literalFlag} or ${fileFlag} is required.`);
  }
  return null;
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

const COMMANDS: readonly CommandDefinition[] = [
  {
    audiences: DEFAULT_HELP_AUDIENCE,
    description: "List direct children, newest activity first.",
    helpGroups: ["subagent"],
    words: ["subagent", "list"],
    usage: "wb subagent list [--cursor <cursor>] [--limit <1-20>]",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(args, { values: ["--cursor", "--limit"] });
      if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
      const limit = flags.optionalNonNegativeInteger("--limit");
      if (limit !== null && (limit < 1 || limit > 20)) throw new Error("--limit must be between 1 and 20.");
      return get(queryPath("/api/subagents", {
        cursor: flags.optional("--cursor"),
        cwd,
        limit: limit === null ? null : String(limit),
        parentThreadId: callerThreadId,
      }), "json");
    },
  },
  {
    audiences: DEFAULT_HELP_AUDIENCE,
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
    audiences: DEFAULT_HELP_AUDIENCE,
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
    audiences: DEFAULT_HELP_AUDIENCE,
    description: "Wait until any selected child has a pending questionnaire or no active turn.",
    helpGroups: ["subagent"],
    words: ["subagent", "wait"],
    usage: "wb subagent wait --id <id> [--id <id>...]",
    async build({ args, callerThreadId, cwd, workbenchOrigin }) {
      const flags = new ParsedFlags(args, { repeatable: ["--id"] });
      if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
      return post("/api/subagents", {
        action: "wait", callerThreadId, cwd, threadIds: flags.requiredRepeated("--id"), ...(workbenchOrigin ? { workbenchOrigin } : {}),
      });
    },
  },
  {
    audiences: DEFAULT_HELP_AUDIENCE,
    description: "Stop a direct child thread.",
    helpGroups: ["subagent"],
    words: ["subagent", "stop"],
    usage: "wb subagent stop --id <id>",
    async build({ args, callerThreadId, cwd, workbenchOrigin }) {
      const flags = new ParsedFlags(args, { values: ["--id"] });
      if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
      return post("/api/subagents", {
        action: "stop", callerThreadId, cwd, threadId: flags.required("--id"), ...(workbenchOrigin ? { workbenchOrigin } : {}),
      });
    },
  },
  {
    audiences: DEFAULT_HELP_AUDIENCE,
    description: "Message a direct child or parent, steering an active turn or starting an idle one.",
    helpGroups: ["subagent"],
    words: ["subagent", "message"],
    usage: "wb subagent message (--id <id> | --parent) --message <message>",
    async build({ args, callerThreadId, cwd, workbenchOrigin }) {
      const flags = new ParsedFlags(args, { boolean: ["--parent"], values: ["--id", "--message"] });
      if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
      const threadId = flags.optional("--id")?.trim() ?? "";
      const parent = flags.has("--parent");
      if (Boolean(threadId) === parent) throw new Error("Exactly one of --id or --parent is required.");
      return post("/api/subagents", {
        action: "message", callerThreadId, cwd, message: flags.required("--message"),
        ...(parent ? { parent: true } : { threadId }),
        ...(workbenchOrigin ? { workbenchOrigin } : {}),
      });
    },
  },
  {
    audiences: SHARED_HELP_AUDIENCES,
    description: "Set a concise title for a managed thread.",
    helpGroups: ["thread"],
    words: ["thread", "title"],
    usage: "wb thread title --thread <id> --harness <codex|copilot|opencode> --title <text>",
    async build({ args }) {
      const flags = new ParsedFlags(args, { values: [...THREAD_FLAG, "--harness", "--title"] });
      const harness = flags.required("--harness");
      if (!["codex", "copilot", "opencode"].includes(harness)) {
        throw new Error("--harness must be codex, copilot, or opencode.");
      }
      return post("/api/thread-title", {
        harness,
        threadId: flags.required("--thread"),
        title: flags.required("--title"),
      }, "thread-title");
    },
  },
  {
    aliases: [["thread", "context", "search"]],
    audiences: SHARED_HELP_AUDIENCES,
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
    audiences: SHARED_HELP_AUDIENCES,
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
    audiences: SHARED_HELP_AUDIENCES,
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
    audiences: DEFAULT_HELP_AUDIENCE,
    description: action === "add"
      ? "Add currently changed files beneath the paths to this thread's commit selection."
      : "Remove exact files or descendants from this thread's commit selection.",
    helpGroups: ["git"],
    words: ["git", action],
    usage: `wb git ${action} --thread <id> -- <path> [<path>...]`,
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(preservePowerShellTrailingPaths(args), { trailing: true, values: THREAD_FLAG });
      if (!flags.trailing.length) throw new Error(`wb git ${action} requires at least one path.`);
      return post("/api/git", {
        action,
        cwd,
        paths: flags.trailing,
        threadId: readOwnedThreadId(flags, callerThreadId),
      });
    },
  })),
  {
    audiences: DEFAULT_HELP_AUDIENCE,
    description: "Commit only this thread's selected files, then clear the selection on success.",
    helpGroups: ["git"],
    words: ["git", "commit"],
    usage: "wb git commit --thread <id> --message <message>",
    async build({ args, callerThreadId, cwd }) {
      const flags = new ParsedFlags(args, { values: [...THREAD_FLAG, "--message"] });
      return post("/api/git", {
        action: "commit",
        cwd,
        message: flags.required("--message"),
        threadId: readOwnedThreadId(flags, callerThreadId),
      });
    },
  },
  ...(["baseline", "create-diff"] as const).map((action): CommandDefinition => ({
    aliases: [["checkpoint", action]],
    audiences: DEFAULT_HELP_AUDIENCE,
    description: action === "baseline"
      ? "Capture the current worktree as a hidden baseline checkpoint."
      : "Preserve the current worktree as an explicit diff checkpoint.",
    helpGroups: ["git-checkpoint"],
    words: ["git", "checkpoint", action],
    usage: `wb git checkpoint ${action} --thread <id>`,
    async build({ args, cwd }) {
      const flags = new ParsedFlags(args, { values: THREAD_FLAG });
      return post("/api/git-checkpoint", {
        action: action === "create-diff" ? "diffCheckpoint" : "baseline",
        cwd,
        threadId: flags.required("--thread"),
      }, "checkpoint-create");
    },
  })),
  {
    aliases: [["checkpoint", "diff"]],
    audiences: DEFAULT_HELP_AUDIENCE,
    description: "Summarize worktree changes since the specified checkpoint.",
    helpGroups: ["git-checkpoint"],
    words: ["git", "checkpoint", "diff"],
    usage: "wb git checkpoint diff --thread <id> --commit <sha>",
    async build({ args, cwd }) {
      const flags = new ParsedFlags(args, { values: [...THREAD_FLAG, "--commit"] });
      return post("/api/git-checkpoint", {
        action: "diff",
        checkpointCommit: flags.required("--commit"),
        cwd,
        threadId: flags.required("--thread"),
      });
    },
  },
  {
    aliases: [["checkpoint", "file-diff"]],
    audiences: DEFAULT_HELP_AUDIENCE,
    description: "Show the unified diff for one file since the specified checkpoint.",
    helpGroups: ["git-checkpoint"],
    words: ["git", "checkpoint", "file-diff"],
    usage: "wb git checkpoint file-diff --thread <id> --commit <sha> --file <path>",
    async build({ args, cwd }) {
      const flags = new ParsedFlags(args, { values: [...THREAD_FLAG, "--commit", "--file"] });
      return post("/api/git-checkpoint", {
        action: "fileDiff",
        checkpointCommit: flags.required("--commit"),
        cwd,
        filePath: flags.required("--file"),
        threadId: flags.required("--thread"),
      });
    },
  },
  {
    aliases: [["checkpoint", "restore"]],
    audiences: DEFAULT_HELP_AUDIENCE,
    description: "Restore the specified checkpoint after explicit confirmation.",
    helpGroups: ["git-checkpoint"],
    words: ["git", "checkpoint", "restore"],
    usage: "wb git checkpoint restore --thread <id> --commit <sha> --confirm",
    async build({ args, cwd }) {
      const flags = new ParsedFlags(args, { boolean: ["--confirm"], values: [...THREAD_FLAG, "--commit"] });
      if (!flags.has("--confirm")) {
        throw new Error("Checkpoint restore requires --confirm.");
      }
      return post("/api/git-checkpoint", {
        action: "restore",
        checkpointCommit: flags.required("--commit"),
        confirmRestore: true,
        cwd,
        threadId: flags.required("--thread"),
      }, "checkpoint-restore");
    },
  },
  {
    audiences: DEFAULT_HELP_AUDIENCE,
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
    audiences: DEFAULT_HELP_AUDIENCE,
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
    audiences: DEFAULT_HELP_AUDIENCE,
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
    audiences: DEFAULT_HELP_AUDIENCE,
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
    audiences: DEFAULT_HELP_AUDIENCE,
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
  {
    audiences: COLLABORATOR_HELP_AUDIENCE,
    description: "Read the current post tree and allowed operations.",
    helpGroups: ["collaboration", "collaboration-posts"],
    words: ["collaboration", "posts", "read"],
    usage: "wb collaboration posts read",
    async build({ args, cwd }) {
      new ParsedFlags(args, {});
      return get(queryPath("/api/collaboration/posts", { cwd }), "json");
    },
  },
  {
    audiences: COLLABORATOR_HELP_AUDIENCE,
    description: "Create an agent post under an eligible user-authored leaf.",
    helpGroups: ["collaboration", "collaboration-posts"],
    words: ["collaboration", "posts", "create"],
    usage: "wb collaboration posts create --parent <id> (--body <markdown> | --body-file <file>) [--prompt <text> | --prompt-file <file>]",
    async build({ args, cwd, readTextFile }) {
      const flags = new ParsedFlags(args, { values: ["--parent", "--body", "--body-file", "--prompt", "--prompt-file"] });
      const body = await readLiteralOrFile(flags, "--body", "--body-file", readTextFile, { required: true });
      const prompt = await readLiteralOrFile(flags, "--prompt", "--prompt-file", readTextFile);
      return post("/api/collaboration/posts", {
        action: "create",
        body: body as string,
        cwd,
        parentId: flags.required("--parent"),
        ...(prompt !== null ? { prompt } : {}),
      }, "collaboration-post-mutation");
    },
  },
  {
    audiences: COLLABORATOR_HELP_AUDIENCE,
    description: "Update a current editable agent-authored leaf.",
    helpGroups: ["collaboration", "collaboration-posts"],
    words: ["collaboration", "posts", "update"],
    usage: "wb collaboration posts update --post <id> (--body <markdown> | --body-file <file>) [--prompt <text> | --prompt-file <file> | --clear-prompt]",
    async build({ args, cwd, readTextFile }) {
      const flags = new ParsedFlags(args, {
        boolean: ["--clear-prompt"],
        values: ["--post", "--body", "--body-file", "--prompt", "--prompt-file"],
      });
      const body = await readLiteralOrFile(flags, "--body", "--body-file", readTextFile, { required: true });
      const prompt = await readLiteralOrFile(flags, "--prompt", "--prompt-file", readTextFile);
      if (flags.has("--clear-prompt") && prompt !== null) {
        throw new Error("--clear-prompt cannot be combined with --prompt or --prompt-file.");
      }
      return post("/api/collaboration/posts", {
        action: "update",
        body: body as string,
        cwd,
        postId: flags.required("--post"),
        ...(flags.has("--clear-prompt") ? { prompt: null } : prompt !== null ? { prompt } : {}),
      }, "collaboration-post-mutation");
    },
  },
  {
    audiences: COLLABORATOR_HELP_AUDIENCE,
    description: "Delete an obsolete current editable agent-authored leaf.",
    helpGroups: ["collaboration", "collaboration-posts"],
    words: ["collaboration", "posts", "delete"],
    usage: "wb collaboration posts delete --post <id>",
    async build({ args, cwd }) {
      const flags = new ParsedFlags(args, { values: ["--post"] });
      return post("/api/collaboration/posts", {
        action: "delete",
        cwd,
        postId: flags.required("--post"),
      }, "collaboration-post-mutation");
    },
  },
  {
    audiences: COLLABORATOR_HELP_AUDIENCE,
    description: "Print the current private next-run memory.",
    helpGroups: ["collaboration", "collaboration-memory"],
    words: ["collaboration", "memory", "read"],
    usage: "wb collaboration memory read",
    async build({ args, cwd }) {
      new ParsedFlags(args, {});
      return get(queryPath("/api/collaboration/memory", { cwd }), "collaboration-memory-read");
    },
  },
  {
    audiences: COLLABORATOR_HELP_AUDIENCE,
    description: "Replace private next-run memory with literal text or file contents.",
    helpGroups: ["collaboration", "collaboration-memory"],
    words: ["collaboration", "memory", "write"],
    usage: "wb collaboration memory write (--memory <text> | --memory-file <file>)",
    async build({ args, cwd, readTextFile }) {
      const flags = new ParsedFlags(args, { values: ["--memory", "--memory-file"] });
      const memory = await readLiteralOrFile(flags, "--memory", "--memory-file", readTextFile, { required: true });
      return post("/api/collaboration/memory", { cwd, memory: memory as string }, "collaboration-memory-write");
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
  "git checkpoint baseline",
  "git checkpoint create-diff",
  "git checkpoint diff",
  "git checkpoint file-diff",
  "git checkpoint restore",
  "browse run",
  "browse raw",
  "browse sessions",
  "browse stop",
  "browse forget",
  "orchestrator reload",
  "collaboration posts read",
  "collaboration posts create",
  "collaboration posts update",
  "collaboration posts delete",
  "collaboration memory read",
  "collaboration memory write",
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
      "Git commands must use the current managed thread ID.",
      "Unrelated files in the ordinary Git index remain outside the thread-owned commit.",
    ].join("\n"),
    key: "git",
    usage: "wb git <command> [options]",
    words: ["git"],
  },
  {
    aliases: [["checkpoint"]],
    commandOrder: [
      "git checkpoint baseline",
      "git checkpoint create-diff",
      "git checkpoint diff",
      "git checkpoint file-diff",
      "git checkpoint restore",
    ],
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
  {
    commandOrder: [
      "collaboration posts read",
      "collaboration posts create",
      "collaboration posts update",
      "collaboration posts delete",
      "collaboration memory read",
      "collaboration memory write",
    ],
    footer: "Project ownership is derived from the current working directory.",
    key: "collaboration",
    usage: "wb collaboration <group> <command> [options]",
    words: ["collaboration"],
  },
  {
    commandOrder: [
      "collaboration posts read",
      "collaboration posts create",
      "collaboration posts update",
      "collaboration posts delete",
    ],
    footer: [
      "On update, omit prompt options to preserve the existing prompt.",
      "Use --clear-prompt to remove the existing prompt.",
      "Literal and file options for the same field are mutually exclusive.",
    ].join("\n"),
    key: "collaboration-posts",
    usage: "wb collaboration posts <command> [options]",
    words: ["collaboration", "posts"],
  },
  {
    commandOrder: ["collaboration memory read", "collaboration memory write"],
    footer: [
      "Writing replaces the entire previous memory.",
      "Do not write when there is no useful memory update.",
    ].join("\n"),
    key: "collaboration-memory",
    usage: "wb collaboration memory <command> [options]",
    words: ["collaboration", "memory"],
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

function isCommandVisible(command: CommandDefinition, audience: WorkbenchAgentCliThreadHelpAudience | "all") {
  return audience === "all" || command.audiences.includes(audience);
}

function renderRootHelp(audience: WorkbenchAgentCliThreadHelpAudience | "all") {
  const commands = orderCommands(
    COMMANDS.filter((command) => isCommandVisible(command, audience)),
    ROOT_HELP_COMMAND_ORDER,
  );
  const helpGroups = HELP_GROUPS.filter((group) => COMMANDS.some((command) => (
    command.helpGroups.includes(group.key) && isCommandVisible(command, audience)
  )));
  return [
    "Usage:",
    "  wb --help [--thread <id>]",
    "  wb <command> [options]",
    "",
    "Commands:",
    ...commands.map((command) => `  ${command.usage}`),
    "",
    "Help commands:",
    ...helpGroups.map((group) => `  wb ${group.words.join(" ")} --help [--thread <id>]`),
    "",
    "Pass --thread <current-thread-id> to hide commands that are not relevant to that thread.",
    "Project ownership is derived from the current working directory.",
    "",
  ].join("\n");
}

function renderGroupHelp(
  group: HelpGroupDefinition,
  audience: WorkbenchAgentCliThreadHelpAudience | "all",
) {
  const commands = orderCommands(
    COMMANDS.filter((command) => command.helpGroups.includes(group.key) && isCommandVisible(command, audience)),
    group.commandOrder ?? [],
  );
  if (!commands.length) {
    return null;
  }

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

function parseHelpThreadId(argv: readonly string[], callerThreadId: string | null) {
  const indexes = argv.flatMap((argument, index) => argument === "--thread" ? [index] : []);
  if (indexes.length > 1) {
    throw new Error("--thread may only be supplied once for help.");
  }
  if (!indexes.length) {
    return null;
  }

  const value = argv[indexes[0] + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error("--thread requires a value for help.");
  }
  if (!callerThreadId) {
    throw new Error("Thread-filtered help requires a managed Workbench thread identity.");
  }
  if (value !== callerThreadId) {
    throw new Error("Thread-filtered help must use the current managed Workbench thread id.");
  }
  return value;
}

function helpPath(argv: readonly string[]) {
  if (argv[0] === "help") {
    return [];
  }
  const threadIndex = argv.indexOf("--thread");
  return argv.filter((_, index) => (
    argv[index] !== "--help"
    && (threadIndex < 0 || (index !== threadIndex && index !== threadIndex + 1))
  ));
}

export const WORKBENCH_AGENT_CLI_HELP = renderRootHelp("all");

export async function parseWorkbenchAgentCliCommand(
  argv: string[],
  {
    cwd = process.cwd(),
    callerThreadId = process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim() || null,
    readTextFile = async (filePath: string) => await readFile(filePath, "utf8"),
    resolveHelpAudience,
    workbenchOrigin = process.env.WORKBENCH_ORIGIN?.trim() || null,
  }: {
    callerThreadId?: string | null;
    cwd?: string;
    readTextFile?: CommandBuildContext["readTextFile"];
    resolveHelpAudience?: (context: {
      cwd: string;
      threadId: string;
    }) => Promise<WorkbenchAgentCliThreadHelpAudience>;
    workbenchOrigin?: string | null;
  } = {},
): Promise<WorkbenchAgentCliParseResult> {
  if (!argv.length || argv.includes("--help") || argv[0] === "help") {
    try {
      const threadId = parseHelpThreadId(argv, callerThreadId);
      const audience = threadId
        ? await resolveHelpAudience?.({ cwd, threadId })
        : "all";
      if (!audience) {
        throw new Error("Thread-filtered help is unavailable.");
      }
      const group = matchHelpGroup(helpPath(argv));
      if (!group) {
        return { help: renderRootHelp(audience), kind: "help" };
      }
      const help = renderGroupHelp(group, audience);
      return help
        ? { help, kind: "help" }
        : {
          error: `wb ${group.words.join(" ")} help is not relevant to this thread.\nRun wb --help --thread <id> to list relevant commands.`,
          kind: "error",
        };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), kind: "error" };
    }
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
      request: await matched.definition.build({ args: argv.slice(matched.words.length), callerThreadId, cwd, readTextFile, workbenchOrigin }),
    };
  } catch (error) {
    return {
      error: `${error instanceof Error ? error.message : String(error)}\n\nUsage: ${matched.definition.usage}`,
      kind: "error",
    };
  }
}
