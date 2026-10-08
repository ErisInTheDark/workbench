/*
 * Exports:
 * - CodexIsolatedRequest: one client request without its JSON-RPC id.
 * - CodexIsolatedTransport: request/respond/dispose over a private Codex app-server.
 * - CodexIsolatedTransportOptions: process root, failure label and server construction seam.
 * - default createCodexIsolatedTransport: spawn a tool-less, MCP-less Codex app-server for Workbench-owned side jobs.
 */
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import type { ClientRequest } from "workbench-shared/codex/generated/app-server/ClientRequest";
import type { RequestId } from "workbench-shared/codex/generated/app-server/RequestId";
import CodexAppServer, { type CodexAppServerOptions } from "./CodexAppServer";

export type CodexIsolatedRequest = ClientRequest extends infer R ? R extends { id: RequestId } ? Omit<R, "id"> : never : never;

export interface CodexIsolatedTransport {
  request(request: CodexIsolatedRequest): Promise<unknown>;
  respond(id: RequestId, result: unknown): void;
  dispose(): Promise<void>;
}

export interface CodexIsolatedTransportOptions {
  /** Process cwd; created on first request. */
  projectRoot: string;
  /** Names the owner in failure messages, such as "Voice transformer". */
  label: string;
  onMessage(message: unknown): Promise<void>;
  onFailure(error: Error): void;
  createServer?: (options: CodexAppServerOptions) => Pick<CodexAppServer, "send" | "stopAsync">;
}

const reply = z.object({
  id: z.union([z.number(), z.string()]), result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const configReply = z.object({ config: z.object({ mcp_servers: z.record(z.string(), z.unknown()).optional() }).passthrough() });

// Side jobs must never reach the user's tools, apps, plugins, agents or MCP servers.
const ISOLATION_CONFIG = [
  "skills.include_instructions=false", "include_apps_instructions=false",
  "include_collaboration_mode_instructions=false", "features.apps=false", "features.plugins=false",
  "features.multi_agent=false", "features.multi_agent_v2=false", "agents.enabled=false",
  "features.shell_tool=false", "features.hooks=false", "features.goals=false", 'web_search="disabled"',
];

export default function createCodexIsolatedTransport({
  projectRoot, label, onMessage, onFailure,
  createServer = options => new CodexAppServer(options),
}: CodexIsolatedTransportOptions): CodexIsolatedTransport {
  let nextId = 0;
  let closed = false;
  let failure: Error | null = null;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => {
    if (closed || failure) return;
    failure = error;
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
    onFailure(error);
  };
  const server = createServer({
    projectRoot,
    args: [...ISOLATION_CONFIG.flatMap(value => ["--config", value]), "app-server", "--listen", "stdio://"],
    onFatalExit: () => fail(new Error(`${label} process exited.`)),
    onMessage(message) {
      const response = reply.safeParse(message);
      if (response.success && typeof response.data.id === "number" && pending.has(response.data.id)) {
        const operation = pending.get(response.data.id)!;
        pending.delete(response.data.id);
        if (response.data.error) operation.reject(new Error(response.data.error.message));
        else operation.resolve(response.data.result);
      } else void onMessage(message).catch(onFailure);
    },
  });
  const raw: CodexIsolatedTransport["request"] = request => new Promise((resolve, reject) => {
    if (closed) { reject(new Error(`${label} transport is disposed.`)); return; }
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try { server.send({ ...request, id }); }
    catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
  const request: CodexIsolatedTransport["request"] = async request => {
    if (closed) throw new Error(`${label} transport is disposed.`);
    if (failure) throw failure;
    await mkdir(projectRoot, { recursive: true });
    if (closed) throw new Error(`${label} transport is disposed.`);
    if (failure) throw failure;
    if (request.method === "thread/start") {
      const config = configReply.parse(await raw({ method: "config/read", params: { includeLayers: false, cwd: request.params.cwd } }));
      const disabled = Object.fromEntries(Object.keys(config.config.mcp_servers ?? {}).map(name => [name, { enabled: false }]));
      request = { ...request, params: { ...request.params, config: { ...request.params.config, mcp_servers: disabled } } };
    }
    const result = await raw(request);
    if (request.method === "initialize" && !closed) server.send({ method: "initialized" });
    return result;
  };
  return {
    request,
    respond(id, result) { if (!closed) server.send({ id, result }); },
    async dispose() {
      closed = true;
      for (const operation of pending.values()) operation.reject(new Error(`${label} transport disposed.`));
      pending.clear();
      await server.stopAsync();
    },
  };
}
