/*
 * Exports:
 * - default WorkbenchAgentCommandController: parse native-shell wb argv and execute structured commands while preserving direct-port lifecycles.
 */
import { randomUUID } from "node:crypto";
import type http from "node:http";
import type { NativeThreadId, WorkbenchThreadId } from "workbench-shared/workbench/identity";

import {
  parseWorkbenchAgentCliCommand,
  type WorkbenchAgentCliRequest,
} from "./lib/workbench/cli/workbench-agent-cli-commands";
import { adaptWorkbenchAgentCliResponse } from "./lib/workbench/cli/workbench-agent-cli-responses";
import type { WorkbenchHarness, WorkbenchReloadDirtSnapshot } from "workbench-shared/types";
import type { DaemonReloadScopeDescriptor } from "workbench-shared/workbench/daemon-reload";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import WorkbenchAgentCommandLogger from "./WorkbenchAgentCommandLogger";
import WorkbenchMarkdownTocController from "./WorkbenchMarkdownTocController";
import WorkbenchRipgrepController from "./WorkbenchRipgrepController";
import type { WorkbenchProviderTools } from "workbench-shared/workbench/provider/provider-execution";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const RELOAD_POLL_INTERVAL_MS = 250;
interface WorkbenchAgentDirectPort {
  resolveCaller?: (threadId: string, cwd: string, harness: string) => Promise<{ threadId: WorkbenchThreadId; nativeThreadId: NativeThreadId; harness: WorkbenchHarness }>;
  patchClaims?: (harness: string, input: { raw: string; callerThreadId: string | null }, signal: AbortSignal) => Promise<string>;
  executeBrowseRequest(body: Buffer, signal: AbortSignal): Promise<Response>;
  executeGitArcRequest?: (body: object, signal: AbortSignal) => Promise<Response>;
  executeQuestionnaireRequest?: (body: object, signal: AbortSignal) => Promise<Response>;
  executeThreadGitRequest?: (body: object, signal: AbortSignal) => Promise<Response>;
  executeThreadRecallRequest?: (request: WorkbenchAgentCliRequest, signal: AbortSignal) => Promise<Response>;
  executeTokenCount?: (body: object, signal: AbortSignal) => Promise<Response>;
  executeTranscriptQuery?: (body: object, signal: AbortSignal) => Promise<Response>;
  executeClaimStats?: (body: object, signal: AbortSignal) => Promise<Response>;
  executeSessionRequest(request: { body: Buffer; method: string; url: string }, signal: AbortSignal): Promise<Response>;
  getReloadScopeCatalog?: () => readonly DaemonReloadScopeDescriptor[];
  readReloadDirtSnapshot?: () => WorkbenchReloadDirtSnapshot;
  executeReadOnly?: (harness: string, ...args: Parameters<WorkbenchProviderTools["executeReadOnly"]>) => ReturnType<WorkbenchProviderTools["executeReadOnly"]>;
  requestSubagent?: (message: JsonRpcRequest) => Promise<JsonRpcResponse>;
  workbenchProjectRoot?: string;
}

interface WorkbenchAgentCommandActiveRequest {
  completion: Promise<void>;
  controller: AbortController;
  label: string;
  startedAt: number;
}

const UNCONFIGURED_DIRECT_PORT: WorkbenchAgentDirectPort = {
  executeBrowseRequest: async () => { throw new Error("Direct Browse dispatch is not configured."); },
  executeSessionRequest: async () => { throw new Error("Direct Browse session dispatch is not configured."); },
};

const SUBAGENT_ACTION_METHODS = {
  create: "workbench/subagent/create",
  list: "workbench/subagent/list",
  message: "workbench/subagent/message",
  profiles: "workbench/subagent/profiles",
  settle: "workbench/subagent/settle",
  stop: "workbench/subagent/stop",
} as const;

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
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(text);
}

function bindRequestAbort(request: http.IncomingMessage, response: http.ServerResponse) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Workbench agent command client disconnected."));
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });
  return controller;
}

function waitForDelay(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const finish = (operation: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      operation();
    };
    const abort = () => finish(() => reject(signal.reason));
    const timer = setTimeout(() => finish(resolve), ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function writeNativeResponse(response: http.ServerResponse, upstream: Response, signal: AbortSignal) {
  response.statusCode = upstream.status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/plain; charset=utf-8");
  if (!upstream.body) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      response.write(Buffer.from(chunk.value));
    }
    if (!response.destroyed && !response.writableEnded) response.end();
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
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
  private readonly activeRequests = new Set<WorkbenchAgentCommandActiveRequest>();
  private acceptingRequests = true;
  private readonly markdownToc = new WorkbenchMarkdownTocController();
  private readonly ripgrep: Pick<WorkbenchRipgrepController, "execute">;

  constructor(
    private readonly daemonOrigin: string,
    private readonly direct: WorkbenchAgentDirectPort = UNCONFIGURED_DIRECT_PORT,
    private readonly fetchRequest: typeof fetch = fetch,
    ripgrep?: Pick<WorkbenchRipgrepController, "execute">,
    private readonly commandLogger = new WorkbenchAgentCommandLogger(),
  ) {
    this.ripgrep = ripgrep ?? new WorkbenchRipgrepController({
      execute: async (harness, request, signal) => {
        if (!this.direct.executeReadOnly) throw new Error("Provider command execution is not configured.");
        return await this.direct.executeReadOnly(harness, request, signal);
      },
    });
  }

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    if (!this.acceptingRequests) {
      sendText(response, 503, "Workbench agent commands are draining for reload.\n");
      return;
    }
    const controller = bindRequestAbort(request, response);
    const active = {
      completion: Promise.resolve(),
      controller,
      label: "wb command admission",
      startedAt: Date.now(),
    };
    active.completion = this.completeHttpRequest(request, response, controller.signal, active)
      .finally(() => { this.activeRequests.delete(active); });
    this.activeRequests.add(active);
    void active.completion;
  }

  beginRuntimeDrain() {
    this.acceptingRequests = false;
    for (const active of this.activeRequests) {
      active.controller.abort(new Error("Workbench agent command was cancelled by a user-authorized reload."));
    }
  }

  async dispose() {
    this.beginRuntimeDrain();
    await Promise.allSettled([...this.activeRequests].map(({ completion }) => completion));
  }

  listRuntimeDrainPending() {
    const now = Date.now();
    return [...this.activeRequests].map(({ label, startedAt }) => ({
      ageMs: Math.max(0, now - startedAt),
      label,
    }));
  }

  private async completeHttpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    signal: AbortSignal,
    active: WorkbenchAgentCommandActiveRequest,
  ) {
    try {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        sendText(response, 403, "Workbench agent commands are available only over loopback.\n");
        return;
      }
      const form = new URLSearchParams(await readBody(request));
      const argv = form.getAll("arg");
      const cwd = form.get("cwd")?.trim() || "";
      const callerThreadId = form.get("callerThreadId")?.trim() || null;
      const callerHarness = form.get("callerHarness")?.trim() || "codex";
      const workbenchOrigin = form.get("workbenchOrigin")?.trim() || this.daemonOrigin;
      active.label = `wb ${argv[0]?.trim() || "command"}`;
      if (!cwd || argv.length > 256 || argv.some((arg) => arg.length > 65_536 || arg.includes("\0"))) {
        sendText(response, 400, "A valid Workbench agent command request is required.\n");
        return;
      }
      if (argv.length === 2 && argv[0] === "__hook" && argv[1] === "apply-patch-claim") {
        await this.handleApplyPatchClaimHook(form, callerHarness, callerThreadId, response, signal);
        return;
      }
      const caller = callerThreadId && this.direct.resolveCaller ? await this.direct.resolveCaller(callerThreadId, cwd, callerHarness) : null;
      const parsed = await parseWorkbenchAgentCliCommand(argv, {
        callerHarness: caller?.harness ?? callerHarness,
        callerThreadId: caller?.threadId ?? callerThreadId,
        cwd,
        reloadCatalog: this.direct.getReloadScopeCatalog?.() ?? [],
        projectRoot: this.direct.workbenchProjectRoot ?? null,
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
      if (parsed.request.waitForReload) {
        this.activeRequests.delete(active);
        await this.admitReloadRequest(parsed.request, response, signal, this.executeStructuredRequest(parsed.request, signal));
        return;
      }
      await this.writeCliResponse(parsed.request, response, await this.executeStructuredRequest(parsed.request, signal), signal);
    } catch (error) {
      if (signal.aborted) {
        sendText(response, 503, `${signal.reason instanceof Error ? signal.reason.message : "Workbench agent command was cancelled."}\n`);
        return;
      }
      sendText(response, 500, `${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  async executeStructuredRequest(request: WorkbenchAgentCliRequest, signal: AbortSignal) {
    return await this.runLoggedCommand(
      `wb ${request.commandName?.trim() || "command"}`,
      signal,
      async () => await this.dispatchRequest(request, signal),
      (response) => response.ok,
    );
  }

  async runLoggedCommand<TValue>(
    label: string,
    signal: AbortSignal,
    operation: () => Promise<TValue>,
    succeeded?: (value: TValue) => boolean,
  ) {
    return await this.commandLogger.run(label, signal, operation, succeeded);
  }

  private async handleApplyPatchClaimHook(
    form: URLSearchParams,
    callerHarness: string,
    callerThreadId: string | null,
    response: http.ServerResponse,
    signal: AbortSignal,
  ) {
    if (!this.direct.patchClaims) throw new Error("The provider patch claim hook is not configured.");
    const decision = await this.direct.patchClaims(callerHarness, { raw: form.get("hookInput") ?? "", callerThreadId }, signal);
    if (!response.destroyed && !response.writableEnded) {
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(`${decision}\n`);
    }
  }

  private buildRequestInit(request: WorkbenchAgentCliRequest, signal: AbortSignal): RequestInit {
    return {
      cache: "no-store",
      method: request.method,
      redirect: "error",
      signal,
      ...(request.body ? {
        body: JSON.stringify(request.body),
        headers: { "Content-Type": "application/json" },
      } : {}),
    };
  }

  private async dispatchRequest(request: WorkbenchAgentCliRequest, signal: AbortSignal) {
    if (request.path === "/api/daemon/reload" && request.body?.all === true) {
      if (!this.direct.readReloadDirtSnapshot) throw new Error("Reload dirt is not configured.");
      const dirt = this.direct.readReloadDirtSnapshot();
      const includeDestructive = request.body.unsafe === true;
      const scopes = [
        ...new Set([
          ...dirt.dirtyScopes.filter((entry) => !entry.destructive || includeDestructive).map(({ scope }) => scope),
          ...(Array.isArray(request.body.scopes) ? request.body.scopes.filter((scope): scope is string => typeof scope === "string") : []),
        ]),
      ];
      if (!scopes.length) {
        const now = Date.now();
        return Response.json({ appliedScopes: [], completedAt: now, error: null, ok: true, queuedScopes: [], requestedScopes: [], startedAt: now, state: "succeeded" });
      }
      request = { ...request, body: { scopes } };
    }
    const body = Buffer.from(request.body ? JSON.stringify(request.body) : "");
    if (request.path === "/api/subagents" && request.body) {
      return await this.dispatchSubagentRequest(request.body, signal);
    }
    if ((request.path === "/api/thread-status" || request.path === "/api/thread-title" || request.path === "/api/thread-resume") && request.body) {
      return await this.dispatchManagedThreadRequest(request.path, request.body, signal);
    }
    if (request.path === "/api/git-checkpoint" && request.body && this.direct.executeGitArcRequest) {
      return await this.direct.executeGitArcRequest(request.body, signal);
    }
    if (request.path === "/api/request-user-input" && request.body && this.direct.executeQuestionnaireRequest) {
      return await this.direct.executeQuestionnaireRequest(request.body, signal);
    }
    if (request.path === "/api/git" && request.body && this.direct.executeThreadGitRequest) {
      return await this.direct.executeThreadGitRequest(request.body, signal);
    }
    if (request.path.startsWith("/api/thread-context/") && this.direct.executeThreadRecallRequest) {
      return await this.direct.executeThreadRecallRequest(request, signal);
    }
    if (request.path === "/api/toc" && request.body) {
      return await this.markdownToc.execute(request.body, signal);
    }
    if (request.path === "/api/rg" && request.body) {
      return await this.ripgrep.execute(request.body, signal);
    }
    if (request.path === "/internal/tokens" && request.body) {
      if (!this.direct.executeTokenCount) throw new Error("Token counting is not configured.");
      return await this.direct.executeTokenCount(request.body, signal);
    }
    if (request.path === "/internal/transcript" && request.body) {
      if (!this.direct.executeTranscriptQuery) throw new Error("Transcript queries are not configured.");
      return await this.direct.executeTranscriptQuery(request.body, signal);
    }
    if (request.path === "/internal/stats/claims" && request.body) {
      if (!this.direct.executeClaimStats) throw new Error("Claim statistics are not configured.");
      return await this.direct.executeClaimStats(request.body, signal);
    }
    if (request.path === "/api/daemon/dirt") {
      if (!this.direct.readReloadDirtSnapshot) throw new Error("Reload dirt is not configured.");
      return Response.json(this.direct.readReloadDirtSnapshot());
    }
    if (request.path === "/api/daemon/reload" && request.body) {
      const admission = await this.fetchRequest(this.resolveUrl(request.path), this.buildRequestInit(request, signal));
      const text = await admission.text();
      if (!admission.ok || readReloadState(text) !== "running") {
        return new Response(text, { headers: admission.headers, status: admission.status });
      }
      return await this.pollUnmanagedReload(request, signal, text);
    }
    if (request.path.startsWith("/api/browse/sessions")) {
      return await this.direct.executeSessionRequest({ body, method: request.method, url: request.path }, signal);
    }
    if (request.path.startsWith("/api/browse")) {
      return await this.direct.executeBrowseRequest(body, signal);
    }
    throw new Error(`Workbench command ${request.commandName?.trim() || request.path} has no direct daemon dispatch.`);
  }

  private async dispatchManagedThreadRequest(pathname: string, body: Record<string, unknown>, signal: AbortSignal) {
    if (!this.direct.requestSubagent) throw new Error("Direct managed-thread dispatch is not configured.");
    if (signal.aborted) throw signal.reason;
    const response = await this.direct.requestSubagent({
      id: 0,
      method: pathname === "/api/thread-status"
        ? "workbench/thread/status"
        : pathname === "/api/thread-resume"
          ? "workbench/thread/resume"
          : "workbench/thread/title",
      params: body,
    });
    if (response.error) return Response.json({ error: response.error.message }, { status: 400 });
    return Response.json(response.result ?? {});
  }

  private async dispatchSubagentRequest(body: Record<string, unknown>, signal: AbortSignal) {
    const requestSubagent = this.direct.requestSubagent;
    if (!requestSubagent) {
      throw new Error("Direct subagent dispatch is not configured.");
    }
    if (signal.aborted) {
      throw signal.reason;
    }

    const action = typeof body.action === "string" ? body.action : "";
    if (action !== "wait") {
      const method = SUBAGENT_ACTION_METHODS[action as keyof typeof SUBAGENT_ACTION_METHODS];
      if (!method) {
        return Response.json({ error: "Unsupported Workbench subagent action." }, { status: 400 });
      }
      const response = await requestSubagent({ id: 0, method, params: body });
      if (response.error) {
        return Response.json({ error: response.error.message }, { status: 400 });
      }
      return Response.json(response.result ?? {});
    }

    const waitId = randomUUID();
    const cancel = () => {
      void requestSubagent({
        id: 0,
        method: "workbench/subagent/waitCancel",
        params: { waitId },
      }).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await requestSubagent({
        id: 0,
        method: "workbench/subagent/wait",
        params: { ...body, waitId },
      });
      if (response.error) {
        return Response.json({ error: response.error.message }, { status: 400 });
      }
      const result = response.result && typeof response.result === "object"
        ? response.result as { output?: unknown }
        : null;
      if (typeof result?.output !== "string") {
        return Response.json({ error: "Workbench subagent wait returned no output." }, { status: 400 });
      }
      return new Response(result.output, {
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
      });
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  private resolveUrl(requestPath: string) {
    if (requestPath.startsWith("/api/daemon/reload")) {
      return new URL(requestPath.replace("/api/daemon/reload", "/daemon/reload"), this.daemonOrigin);
    }
    throw new Error(`Workbench command path is not an daemon reload endpoint: ${requestPath}`);
  }

  private async admitReloadRequest(
    request: WorkbenchAgentCliRequest,
    response: http.ServerResponse,
    signal: AbortSignal,
    completion: Promise<Response>,
  ) {
    // The stable reload coordinator owns the long wait after this feature-generation lease returns.
    void this.completeReloadResponse(request, response, signal, completion);
  }

  private async completeReloadResponse(
    request: WorkbenchAgentCliRequest,
    target: http.ServerResponse,
    signal: AbortSignal,
    completion: Promise<Response>,
  ) {
    try {
      await this.writeCliResponse(request, target, await completion, signal);
    } catch (error) {
      if (signal.aborted) return;
      sendText(target, 500, `${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private async pollUnmanagedReload(request: WorkbenchAgentCliRequest, signal: AbortSignal, initialText: string) {
    let response: Response | null = null;
    let text = initialText;
    let state = readReloadState(text);
    while (state === "running") {
      await waitForDelay(RELOAD_POLL_INTERVAL_MS, signal);
      try {
        response = await this.fetchRequest(this.resolveUrl(request.path), { cache: "no-store", method: "GET", redirect: "error", signal });
      } catch (error) {
        if (signal.aborted) throw error;
        continue;
      }
      if (!response.ok) continue;
      text = await response.text();
      state = readReloadState(text);
    }
    return new Response(text, { headers: response?.headers, status: response?.status ?? 200 });
  }

  private async writeCliResponse(
    request: WorkbenchAgentCliRequest,
    response: http.ServerResponse,
    upstream: Response,
    signal: AbortSignal,
  ) {
    const streamsNative = upstream.ok && (
      request.responseKind === "native"
      || upstream.headers.get("content-type")?.includes("application/x-ndjson")
    );
    if (streamsNative) {
      await writeNativeResponse(response, upstream, signal);
      return;
    }
    const text = await upstream.text();
    const adapted = adaptWorkbenchAgentCliResponse({ httpOk: upstream.ok, request, text });
    sendText(response, adapted.exitCode === 0 ? 200 : 400, adapted.exitCode === 0 ? adapted.stdout : adapted.stderr);
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

function parseRecord(text: string) {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readRecordString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}
