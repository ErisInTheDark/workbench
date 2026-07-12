/*
 * Exports:
 * - WorkbenchAgentCliRequest/WorkbenchAgentCliParseResult: normalized allowlisted CLI request and parse result contracts. Keywords: workbench, cli, request, parse.
 * - WORKBENCH_AGENT_CLI_HELP: complete agent-facing command reference. Keywords: workbench, cli, help, commands.
 * - parseWorkbenchAgentCliCommand: parse one allowlisted wb command into a fixed Workbench request. Keywords: workbench, cli, allowlist, cwd.
 */
import { readFile } from "node:fs/promises";

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
  cwd: string;
  readTextFile: (filePath: string) => Promise<string>;
}

interface CommandDefinition {
  aliases?: readonly (readonly string[])[];
  build: (context: CommandBuildContext) => Promise<WorkbenchAgentCliRequest>;
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
const RELOAD_SWITCHES = [
  "--orchestrator-logic",
  "--browse-controller",
  "--codex-bridge",
  "--opencode-bridge",
  "--opencode-server",
  "--next-dev",
] as const;

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

function queryPath(pathname: string, values: Record<string, string | null>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) {
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
    words: ["thread", "recall", "search"],
    usage: "wb thread recall search --thread <id> --query <text> [--kind <kind>...] [--limit <count>]",
    async build({ args }) {
      const flags = new ParsedFlags(args, {
        repeatable: ["--kind"],
        values: [...THREAD_FLAG, "--query", "--limit"],
      });
      const kinds = flags.repeated("--kind");
      const limit = flags.optionalNonNegativeInteger("--limit");
      return post(`/api/thread-context/${encodeURIComponent(flags.required("--thread"))}`, {
        action: "search",
        query: flags.required("--query"),
        ...(kinds.length ? { kinds } : {}),
        ...(limit !== null ? { limit } : {}),
      });
    },
  },
  {
    aliases: [["thread", "context", "expand"]],
    words: ["thread", "recall", "expand"],
    usage: "wb thread recall expand --thread <id> --ref <ref> [--before <count>] [--after <count>] [--max-chars <count>]",
    async build({ args }) {
      const flags = new ParsedFlags(args, { values: [...THREAD_FLAG, "--ref", "--before", "--after", "--max-chars"] });
      const before = flags.optionalNonNegativeInteger("--before");
      const after = flags.optionalNonNegativeInteger("--after");
      const maxChars = flags.optionalNonNegativeInteger("--max-chars");
      return post(`/api/thread-context/${encodeURIComponent(flags.required("--thread"))}`, {
        action: "expand",
        ref: flags.required("--ref"),
        ...(before !== null ? { before } : {}),
        ...(after !== null ? { after } : {}),
        ...(maxChars !== null ? { maxChars } : {}),
      });
    },
  },
  {
    aliases: [["thread", "context"]],
    words: ["thread", "recall"],
    usage: "wb thread recall --thread <id> [--before <ref>]",
    async build({ args }) {
      const flags = new ParsedFlags(args, { values: [...THREAD_FLAG, "--before"] });
      const threadId = flags.required("--thread");
      return get(queryPath(`/api/thread-context/${encodeURIComponent(threadId)}`, {
        before: flags.optional("--before"),
      }));
    },
  },
  ...(["baseline", "create-diff"] as const).map((action): CommandDefinition => ({
    words: ["checkpoint", action],
    usage: `wb checkpoint ${action} --thread <id>`,
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
    words: ["checkpoint", "diff"],
    usage: "wb checkpoint diff --thread <id> --commit <sha>",
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
    words: ["checkpoint", "file-diff"],
    usage: "wb checkpoint file-diff --thread <id> --commit <sha> --file <path>",
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
    words: ["checkpoint", "restore"],
    usage: "wb checkpoint restore --thread <id> --commit <sha> --confirm",
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
    words: ["browse", "run"],
    usage: "wb browse run --thread <id> [--session <name>] (--command <line>... | --script-path <file>) [--var key=value]",
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
    words: ["browse", "sessions"],
    usage: "wb browse sessions --thread <id>",
    async build({ args, cwd }) {
      const flags = new ParsedFlags(args, { values: THREAD_FLAG });
      return get(queryPath("/api/browse/sessions", { cwd, threadId: flags.required("--thread") }), "json");
    },
  },
  ...(["stop", "forget"] as const).map((action): CommandDefinition => ({
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
    words: ["orchestrator", "reload"],
    usage: "wb orchestrator reload [--orchestrator-logic] [--browse-controller] [--codex-bridge] [--opencode-bridge] [--opencode-server] [--next-dev]",
    async build({ args }) {
      const flags = new ParsedFlags(args, { boolean: RELOAD_SWITCHES });
      const scopes = RELOAD_SWITCHES
        .filter((flag) => flags.has(flag))
        .map((flag) => flag.slice(2));
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
    words: ["collaboration", "posts", "read"],
    usage: "wb collaboration posts read",
    async build({ args, cwd }) {
      new ParsedFlags(args, {});
      return get(queryPath("/api/collaboration/posts", { cwd }), "json");
    },
  },
  {
    words: ["collaboration", "posts", "create"],
    usage: "wb collaboration posts create --parent <id> (--body <md> | --body-file <file>) [--prompt <text> | --prompt-file <file>]",
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
    words: ["collaboration", "posts", "update"],
    usage: "wb collaboration posts update --post <id> (--body <md> | --body-file <file>) [--prompt <text> | --prompt-file <file> | --clear-prompt]",
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
    words: ["collaboration", "memory", "read"],
    usage: "wb collaboration memory read",
    async build({ args, cwd }) {
      new ParsedFlags(args, {});
      return get(queryPath("/api/collaboration/memory", { cwd }), "collaboration-memory-read");
    },
  },
  {
    words: ["collaboration", "memory", "write"],
    usage: "wb collaboration memory write (--memory <text> | --memory-file <file>)",
    async build({ args, cwd, readTextFile }) {
      const flags = new ParsedFlags(args, { values: ["--memory", "--memory-file"] });
      const memory = await readLiteralOrFile(flags, "--memory", "--memory-file", readTextFile, { required: true });
      return post("/api/collaboration/memory", { cwd, memory: memory as string }, "collaboration-memory-write");
    },
  },
];

export const WORKBENCH_AGENT_CLI_HELP = `Workbench agent CLI

Usage: wb <command> [options]

${COMMANDS.map((command) => `  ${command.usage}`).join("\n")}

Compatibility alias: replace \`wb thread recall\` with \`wb thread context\`.

Project ownership is derived from the current working directory.
`;

export async function parseWorkbenchAgentCliCommand(
  argv: string[],
  {
    cwd = process.cwd(),
    readTextFile = async (filePath: string) => await readFile(filePath, "utf8"),
  }: {
    cwd?: string;
    readTextFile?: CommandBuildContext["readTextFile"];
  } = {},
): Promise<WorkbenchAgentCliParseResult> {
  if (!argv.length || argv.includes("--help") || argv[0] === "help") {
    return { help: WORKBENCH_AGENT_CLI_HELP, kind: "help" };
  }

  const matched = COMMANDS.flatMap((definition) => (
    [definition.words, ...(definition.aliases ?? [])].map((words) => ({ definition, words }))
  ))
    .filter((candidate) => candidate.words.every((word, index) => argv[index] === word))
    .sort((left, right) => right.words.length - left.words.length)[0];
  if (!matched) {
    return { error: `Unsupported wb command: ${argv.join(" ")}\n\n${WORKBENCH_AGENT_CLI_HELP}`, kind: "error" };
  }

  try {
    return {
      kind: "request",
      request: await matched.definition.build({ args: argv.slice(matched.words.length), cwd, readTextFile }),
    };
  } catch (error) {
    return {
      error: `${error instanceof Error ? error.message : String(error)}\n\nUsage: ${matched.definition.usage}`,
      kind: "error",
    };
  }
}
