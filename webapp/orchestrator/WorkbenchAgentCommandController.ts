/*
 * Exports:
 * - default WorkbenchAgentCommandController: parse native-shell wb argv, route allowlisted requests to their owners, adapt output, and stream native responses. Keywords: workbench, agent, command, shell, orchestrator, transport.
 */
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";

import {
  parseWorkbenchAgentCliCommand,
  type WorkbenchAgentCliRequest,
} from "../lib/workbench/cli/workbench-agent-cli-commands";
import { adaptWorkbenchAgentCliResponse } from "../lib/workbench/cli/workbench-agent-cli-responses";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const RELOAD_POLL_INTERVAL_MS = 250;
const RELOAD_TIMEOUT_MS = 60_000;

async function readBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BODY_BYTES) throw new Error("Workbench agent command request is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendText(response: http.ServerResponse, status: number, text: string) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(text);
}

function isLoopbackAddress(address: string | undefined) {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::1"
    || normalized === "127.0.0.1"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.");
}

export default class WorkbenchAgentCommandController {
  constructor(
    private readonly nextOrigin: string,
    private readonly orchestratorOrigin: string,
    private readonly fetchRequest: typeof fetch = fetch,
  ) {}

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        sendText(response, 403, "Workbench agent commands are available only over loopback.\n");
        return;
      }
      const form = new URLSearchParams(await readBody(request));
      const argv = form.getAll("arg");
      const cwd = form.get("cwd")?.trim() || "";
      const callerThreadId = form.get("callerThreadId")?.trim() || null;
      const workbenchOrigin = form.get("workbenchOrigin")?.trim() || this.orchestratorOrigin;
      if (!cwd || argv.length > 256 || argv.some((arg) => arg.length > 65_536 || arg.includes("\0"))) {
        sendText(response, 400, "A valid Workbench agent command request is required.\n");
        return;
      }
      const parsed = await parseWorkbenchAgentCliCommand(argv, {
        callerThreadId,
        cwd,
        readTextFile: async (filePath) => await fs.readFile(path.resolve(cwd, filePath), "utf8"),
        workbenchOrigin,
      });
      if (parsed.kind === "help") {
        sendText(response, 200, parsed.help);
        return;
      }
      if (parsed.kind === "error") {
        sendText(response, 400, `${parsed.error}\n`);
        return;
      }
      const upstream = parsed.request.waitForReload
        ? await this.runReloadRequest(parsed.request)
        : await this.fetchRequest(this.resolveUrl(parsed.request.path), this.buildRequestInit(parsed.request));
      const streamsNative = upstream.ok && (
        parsed.request.responseKind === "native"
        || upstream.headers.get("content-type")?.includes("application/x-ndjson")
      );
      if (streamsNative) {
        response.statusCode = upstream.status;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/plain; charset=utf-8");
        if (!upstream.body) {
          response.end();
          return;
        }
        const reader = upstream.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          response.write(Buffer.from(chunk.value));
        }
        response.end();
        return;
      }
      const text = await upstream.text();
      const adapted = adaptWorkbenchAgentCliResponse({ httpOk: upstream.ok, request: parsed.request, text });
      sendText(response, adapted.exitCode === 0 ? 200 : 400, adapted.exitCode === 0 ? adapted.stdout : adapted.stderr);
    } catch (error) {
      sendText(response, 500, `${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private buildRequestInit(request: WorkbenchAgentCliRequest): RequestInit {
    return {
      cache: "no-store",
      method: request.method,
      redirect: "error",
      ...(request.body ? {
        body: JSON.stringify(request.body),
        headers: { "Content-Type": "application/json" },
      } : {}),
    };
  }

  private resolveUrl(requestPath: string) {
    if (requestPath.startsWith("/api/browse/sessions")) {
      return new URL(requestPath.replace("/api/browse/sessions", "/orchestrator/browse/sessions"), this.orchestratorOrigin);
    }
    if (requestPath.startsWith("/api/browse")) {
      return new URL(requestPath.replace("/api/browse", "/orchestrator/browse"), this.orchestratorOrigin);
    }
    if (requestPath.startsWith("/api/orchestrator/reload")) {
      return new URL(requestPath.replace("/api/orchestrator/reload", "/orchestrator/reload"), this.orchestratorOrigin);
    }
    return new URL(requestPath, this.nextOrigin);
  }

  private async runReloadRequest(request: WorkbenchAgentCliRequest) {
    let response = await this.fetchRequest(this.resolveUrl(request.path), this.buildRequestInit(request));
    if (!response.ok) return response;
    let text = await response.text();
    let state = readReloadState(text);
    const deadline = Date.now() + RELOAD_TIMEOUT_MS;
    while (state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RELOAD_POLL_INTERVAL_MS));
      response = await this.fetchRequest(this.resolveUrl(request.path), { cache: "no-store", method: "GET", redirect: "error" });
      if (!response.ok) continue;
      text = await response.text();
      state = readReloadState(text);
    }
    if (state === "running") {
      return new Response(JSON.stringify({ error: `Workbench orchestrator reload did not settle within ${RELOAD_TIMEOUT_MS}ms.` }), { status: 504 });
    }
    return new Response(text, { headers: response.headers, status: response.status });
  }
}

function readReloadState(text: string) {
  try {
    const parsed = JSON.parse(text) as { state?: string };
    return parsed.state === "running" || parsed.state === "succeeded" || parsed.state === "failed" ? parsed.state : null;
  } catch {
    return null;
  }
}
