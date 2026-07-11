/*
 * Exports:
 * - WorkbenchAgentCliIo/WorkbenchAgentCliOptions: injectable CLI runtime boundaries. Keywords: workbench, cli, io, fetch.
 * - default WorkbenchAgentCli: execute allowlisted Workbench requests against the orchestrator-owned loopback origin. Keywords: workbench, cli, controller, transport.
 * - runWorkbenchAgentCli: run the CLI with process defaults and return its exit code. Keywords: workbench, cli, entrypoint, process.
 */
import { pathToFileURL } from "node:url";

import {
  parseWorkbenchAgentCliCommand,
  type WorkbenchAgentCliRequest,
} from "./workbench-agent-cli-commands.ts";
import { adaptWorkbenchAgentCliResponse } from "./workbench-agent-cli-responses.ts";

export interface WorkbenchAgentCliIo {
  writeStderr: (value: string) => void;
  writeStdout: (value: string) => void;
}

export interface WorkbenchAgentCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchRequest?: typeof fetch;
  io?: WorkbenchAgentCliIo;
  reloadPollIntervalMs?: number;
  reloadTimeoutMs?: number;
}

const DEFAULT_IO: WorkbenchAgentCliIo = {
  writeStderr: (value) => process.stderr.write(value),
  writeStdout: (value) => process.stdout.write(value),
};

function readWorkbenchOrigin(env: NodeJS.ProcessEnv) {
  const rawOrigin = env.WORKBENCH_ORIGIN?.trim();
  if (!rawOrigin) {
    throw new Error("WORKBENCH_ORIGIN is unavailable. Run wb from a Workbench-managed agent process.");
  }
  const origin = new URL(rawOrigin);
  const isLoopback = origin.hostname === "localhost" || origin.hostname === "127.0.0.1" || origin.hostname === "[::1]";
  if (origin.protocol !== "http:" || !isLoopback || origin.username || origin.password || origin.pathname !== "/") {
    throw new Error("WORKBENCH_ORIGIN must be an unauthenticated loopback HTTP origin.");
  }
  return origin;
}

function buildRequestInit(request: WorkbenchAgentCliRequest): RequestInit {
  return {
    cache: "no-store",
    method: request.method,
    redirect: "error",
    ...(request.body
      ? {
        body: JSON.stringify(request.body),
        headers: { "Content-Type": "application/json" },
      }
      : {}),
  };
}

async function streamResponse(response: Response, write: (value: string) => void) {
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    write(decoder.decode(chunk.value, { stream: true }));
  }
  const remainder = decoder.decode();
  if (remainder) {
    write(remainder);
  }
}

export default class WorkbenchAgentCli {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchRequest: typeof fetch;
  private readonly io: WorkbenchAgentCliIo;
  private readonly reloadPollIntervalMs: number;
  private readonly reloadTimeoutMs: number;

  constructor({
    cwd = process.cwd(),
    env = process.env,
    fetchRequest = fetch,
    io = DEFAULT_IO,
    reloadPollIntervalMs = 250,
    reloadTimeoutMs = 60_000,
  }: WorkbenchAgentCliOptions = {}) {
    this.cwd = cwd;
    this.env = env;
    this.fetchRequest = fetchRequest;
    this.io = io;
    this.reloadPollIntervalMs = reloadPollIntervalMs;
    this.reloadTimeoutMs = reloadTimeoutMs;
  }

  async run(argv: string[]) {
    const parsed = await parseWorkbenchAgentCliCommand(argv, { cwd: this.cwd });
    if (parsed.kind === "help") {
      this.io.writeStdout(parsed.help);
      return 0;
    }
    if (parsed.kind === "error") {
      this.io.writeStderr(`${parsed.error}\n`);
      return 2;
    }

    try {
      const url = new URL(parsed.request.path, readWorkbenchOrigin(this.env));
      if (parsed.request.waitForReload) {
        return await this.runReloadRequest(url, parsed.request);
      }
      const response = await this.fetchRequest(url, buildRequestInit(parsed.request));
      const streamsNativeOutput = response.ok && (
        parsed.request.responseKind === "native"
        || response.headers.get("content-type")?.includes("application/x-ndjson")
      );
      if (streamsNativeOutput) {
        await streamResponse(response, this.io.writeStdout);
        return 0;
      }
      return this.writeAdaptedResponse(parsed.request, response.ok, await response.text());
    } catch (error) {
      this.io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  private async runReloadRequest(url: URL, request: WorkbenchAgentCliRequest) {
    const initialResponse = await this.fetchRequest(url, buildRequestInit(request));
    const initialText = await initialResponse.text();
    if (!initialResponse.ok) {
      return this.writeAdaptedResponse(request, false, initialText || `Workbench reload request failed with HTTP ${initialResponse.status}.`);
    }

    let latestText = initialText;
    let state = readReloadState(initialText);
    const deadline = Date.now() + this.reloadTimeoutMs;
    while (state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.reloadPollIntervalMs));
      try {
        const response = await this.fetchRequest(url, { cache: "no-store", method: "GET", redirect: "error" });
        const responseText = await response.text();
        if (!response.ok) {
          continue;
        }
        latestText = responseText;
        state = readReloadState(responseText);
      } catch {
        // Next.js may be unavailable briefly while the requested next-dev scope restarts it.
      }
    }

    if (state === "succeeded") {
      return this.writeAdaptedResponse(request, true, latestText);
    }
    if (state === "failed") {
      return this.writeAdaptedResponse(request, true, latestText);
    }
    this.io.writeStderr(`Workbench orchestrator reload did not settle within ${this.reloadTimeoutMs}ms.\n`);
    return 1;
  }

  private writeAdaptedResponse(request: WorkbenchAgentCliRequest, httpOk: boolean, text: string) {
    const adapted = adaptWorkbenchAgentCliResponse({ httpOk, request, text });
    if (adapted.stdout) {
      this.io.writeStdout(adapted.stdout);
    }
    if (adapted.stderr) {
      this.io.writeStderr(adapted.stderr);
    }
    return adapted.exitCode;
  }
}

function readReloadState(value: string) {
  try {
    const parsed = JSON.parse(value) as { state?: string };
    return parsed.state === "running" || parsed.state === "succeeded" || parsed.state === "failed"
      ? parsed.state
      : null;
  } catch {
    return null;
  }
}

export async function runWorkbenchAgentCli(argv = process.argv.slice(2)) {
  return await new WorkbenchAgentCli().run(argv);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await runWorkbenchAgentCli();
}
