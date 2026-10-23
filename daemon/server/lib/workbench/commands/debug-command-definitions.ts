/*
 * Exports:
 * - WorkbenchSocketSpyRequestSchema: validate one socket spy search or read for daemon and app frame buffers.
 * - formatWorkbenchSocketSpy: render spy answers as scannable text with exact payloads on read.
 * - WorkbenchMcpSpyRequestSchema: validate one `{ query }` search or read of recent raw MCP server traffic.
 * - formatWorkbenchMcpSpy: render MCP traffic answers in the socket spy's format.
 * - WorkbenchHeapSnapshotRequestSchema: the (empty) `wb debug heap` request.
 * - WORKBENCH_DEBUG_COMMANDS: `wb debug socket`, `wb debug mcp` and `wb debug heap`; CLI only, shown and runnable only from the Workbench repo cwd.
 */
import { z } from "zod";

import {
  WebSocketTrafficQuerySchema, type WebSocketTrafficQuery, type WebSocketTrafficResult,
} from "workbench-shared/process/WebSocketTrafficBuffer";
import { WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import { defineWorkbenchAgentCommand, postWorkbenchAgentCommand } from "./workbench-agent-command-definition";

const target = z.enum(["all", "daemon", "app"]);
export const WorkbenchSocketSpyRequestSchema = z.object({ target, query: WebSocketTrafficQuerySchema }).strict();
type SpyRequest = z.infer<typeof WorkbenchSocketSpyRequestSchema>;

const USAGE = "wb debug socket [--process daemon|app] [--grep <text>] [--label <prefix>] [--direction in|out] [--before <seq>] [--limit <n>] | wb debug socket --show <daemon|app>:<seq>";

function parse(args: string[]): SpyRequest {
  const flags = new WorkbenchAgentCommandFlags(args, {
    values: ["--process", "--grep", "--label", "--direction", "--before", "--limit", "--show"],
  });
  const show = flags.optional("--show");
  if (show) {
    const match = /^(daemon|app):(\d+)$/u.exec(show);
    if (!match) throw new Error("--show takes <daemon|app>:<seq>, as printed by a spy search.");
    return { target: match[1] as "daemon" | "app", query: { action: "read", seq: Number(match[2]) } };
  }
  const number = (flag: string) => {
    const value = flags.optional(flag);
    return value === null ? undefined : Number(value);
  };
  return {
    target: target.parse(flags.optional("--process") ?? "all"),
    query: WebSocketTrafficQuerySchema.parse({
      action: "search",
      ...(flags.optional("--grep") ? { grep: flags.optional("--grep") } : {}),
      ...(flags.optional("--label") ? { label: flags.optional("--label") } : {}),
      ...(flags.optional("--direction") ? { direction: flags.optional("--direction") } : {}),
      ...(number("--before") !== undefined ? { before: number("--before") } : {}),
      ...(number("--limit") !== undefined ? { limit: number("--limit") } : {}),
    }),
  };
}

function time(at: number) {
  return new Date(at).toISOString().slice(11, 23);
}

function size(bytes: number) {
  return bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function renderResult(process: string, result: WebSocketTrafficResult) {
  if (result.action === "read") {
    if (!result.entry) return `${process}: that frame is no longer retained.`;
    const entry = result.entry;
    return `${process}:${entry.seq} ${time(entry.at)} ${entry.direction} ${entry.connection} ${size(entry.bytes)}${entry.truncated ? " (payload truncated)" : ""}\n`
      + `${entry.label}\n${entry.payload}`;
  }
  const { retained } = result;
  const header = `${process}: ${result.entries.length} match(es); retaining ${retained.count} frames / ${size(retained.bytes)} `
    + `(seq ${retained.oldestSeq}-${retained.newestSeq})`;
  return [header, ...result.entries.map(entry =>
    `  ${process}:${entry.seq} ${time(entry.at)} ${entry.direction.padEnd(3)} ${entry.connection} ${size(entry.bytes).padStart(7)} ${entry.label}\n`
    + `      ${entry.preview.replace(/\s+/gu, " ")}${entry.truncated || entry.preview.length >= 240 ? " ..." : ""}`)].join("\n");
}

export function formatWorkbenchSocketSpy(answer: {
  daemon: WebSocketTrafficResult | null;
  apps: Array<{ connection: string; result: WebSocketTrafficResult | null; failure: string | null }>;
}) {
  const sections: string[] = [];
  if (answer.daemon) sections.push(renderResult("daemon", answer.daemon));
  const answered = answer.apps.filter(app => app.result);
  for (const app of answered) sections.push(renderResult("app", app.result!));
  // Peer daemons and CLI connections never answer; mention them only when no app did.
  if (!answered.length && answer.apps.length) {
    sections.push(`app: no app server answered (${answer.apps.map(app => `${app.connection}: ${app.failure}`).join("; ")})`);
  }
  return `${sections.join("\n\n")}\n`;
}

/** Debug tooling is for working on Workbench itself: CLI only, and only from the Workbench repo cwd. */
const DEBUG_VISIBILITY = {
  helpGroups: ["debug"], mcpDeferred: true, hideFromRootHelp: true, managedThreadRootOnly: true,
} as const;

const socket = defineWorkbenchAgentCommand({
  ...DEBUG_VISIBILITY,
  description: "Search recent daemon and app WebSocket frames, or print one frame's exact payload.",
  effects: { idempotent: true, openWorld: false, readOnly: true },
  words: ["debug", "socket"],
  usage: USAGE,
  inputSchema: WorkbenchSocketSpyRequestSchema,
  parseCliArgs: parse,
  buildRequest(input) {
    return postWorkbenchAgentCommand("/internal/debug/socket", input);
  },
});

/** Wrapped like the socket spy's, since a bare search/read union cannot list as an MCP tool input. */
export const WorkbenchMcpSpyRequestSchema = z.object({ query: WebSocketTrafficQuerySchema }).strict();

const MCP_USAGE = "wb debug mcp [--server <name>] [--grep <text>] [--direction in|out] [--before <seq>] [--limit <n>] | wb debug mcp --show <seq>";

function parseMcp(args: string[]) {
  return { query: parseMcpQuery(args) };
}

function parseMcpQuery(args: string[]): WebSocketTrafficQuery {
  const flags = new WorkbenchAgentCommandFlags(args, {
    values: ["--server", "--grep", "--direction", "--before", "--limit", "--show"],
  });
  const show = flags.optional("--show");
  if (show) {
    const seq = /^(?:mcp:)?(\d+)$/u.exec(show)?.[1];
    if (!seq) throw new Error("--show takes a <seq> printed by a search.");
    return { action: "read", seq: Number(seq) };
  }
  const number = (flag: string) => {
    const value = flags.optional(flag);
    return value === null ? undefined : Number(value);
  };
  const server = flags.optional("--server");
  return WebSocketTrafficQuerySchema.parse({
    action: "search",
    // Labels are `<server> <method>`; the trailing space keeps `eris` from matching `erisx`.
    ...(server ? { label: `${server} ` } : {}),
    ...(flags.optional("--grep") ? { grep: flags.optional("--grep") } : {}),
    ...(flags.optional("--direction") ? { direction: flags.optional("--direction") } : {}),
    ...(number("--before") !== undefined ? { before: number("--before") } : {}),
    ...(number("--limit") !== undefined ? { limit: number("--limit") } : {}),
  });
}

export function formatWorkbenchMcpSpy(result: WebSocketTrafficResult) {
  return `${renderResult("mcp", result)}\n`;
}

const mcp = defineWorkbenchAgentCommand({
  ...DEBUG_VISIBILITY,
  description: "Search recent raw JSON-RPC traffic with user-added MCP servers, or print one message's exact payload.",
  effects: { idempotent: true, openWorld: false, readOnly: true },
  words: ["debug", "mcp"],
  usage: MCP_USAGE,
  inputSchema: WorkbenchMcpSpyRequestSchema,
  parseCliArgs: parseMcp,
  buildRequest(input) {
    return postWorkbenchAgentCommand("/internal/debug/mcp", input);
  },
});

export const WorkbenchHeapSnapshotRequestSchema = z.object({}).strict();

const heap = defineWorkbenchAgentCommand({
  ...DEBUG_VISIBILITY,
  description: "Write one heap snapshot of the daemon process (pauses it for a few seconds) and print its path.",
  effects: { idempotent: false, openWorld: false, readOnly: false },
  words: ["debug", "heap"],
  usage: "wb debug heap",
  inputSchema: WorkbenchHeapSnapshotRequestSchema,
  parseCliArgs: args => {
    // Rejects any argument: the command takes none.
    new WorkbenchAgentCommandFlags(args, {});
    return {};
  },
  buildRequest(input) {
    return postWorkbenchAgentCommand("/internal/debug/heap", input);
  },
});

export const WORKBENCH_DEBUG_COMMANDS = [socket, mcp, heap] as const;
