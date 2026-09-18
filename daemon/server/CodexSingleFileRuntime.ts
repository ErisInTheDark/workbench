/*
 * Exports:
 * - default createCodexSingleFileRuntime: isolated native transport and owned scratch documents.
 */
import os from "node:os";
import { z } from "zod";
import CodexSingleFileDocuments from "./CodexSingleFileDocuments";
import CodexAppServer, { type CodexAppServerOptions } from "./CodexAppServer";
import type { CodexSingleFileOptions, SingleFileTransport } from "./CodexSingleFileController";

const reply = z.object({
  id: z.union([z.number(), z.string()]), result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const configReply = z.object({ config: z.object({ mcp_servers: z.record(z.string(), z.unknown()).optional() }).passthrough() });

export default function createCodexSingleFileRuntime(
  directory: string,
  createServer: (options: CodexAppServerOptions) => Pick<CodexAppServer, "send" | "stopAsync"> = options => new CodexAppServer(options),
): CodexSingleFileOptions {
  const documents = new CodexSingleFileDocuments(directory);
  return {
    createDocument: text => documents.create(text),
    createTransport(onMessage, onFailure): SingleFileTransport {
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
        projectRoot: os.tmpdir(),
        args: [
          ...[
            "skills.include_instructions=false", "include_apps_instructions=false",
            "include_collaboration_mode_instructions=false", "features.apps=false", "features.plugins=false",
            "features.multi_agent=false", "features.multi_agent_v2=false", "agents.enabled=false",
            "features.shell_tool=false", "features.hooks=false", 'web_search="disabled"',
          ].flatMap(value => ["--config", value]),
          "app-server", "--listen", "stdio://",
        ],
        onFatalExit: () => fail(new Error("Voice transformer process exited.")),
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
      const request: SingleFileTransport["request"] = async request => {
        if (closed) throw new Error("Voice transport is disposed.");
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
      const raw: SingleFileTransport["request"] = request => new Promise((resolve, reject) => {
        if (closed) { reject(new Error("Voice transport is disposed.")); return; }
        if (failure) { reject(failure); return; }
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        try { server.send({ ...request, id }); }
        catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
      return {
        request,
        respond(id, result) { if (!closed) server.send({ id, result }); },
        async dispose() {
          closed = true;
          for (const operation of pending.values()) operation.reject(new Error("Voice transport disposed."));
          pending.clear();
          await server.stopAsync();
        },
      };
    },
  };
}
