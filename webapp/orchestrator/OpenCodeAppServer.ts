/*
 * Exports:
 * - OpenCodeAppServerOptions: injected SDK, environment, clock, config, and logging ports. Keywords: opencode, server, test.
 * - default OpenCodeAppServer: own external selection, managed startup, cooldown, disabled state, restart, and shutdown. Keywords: provider, lifecycle, ownership.
 */
import type { createOpencodeServer as createOpenCodeServer } from "@opencode-ai/sdk/v2";

import type { OrchestratorReloadableModules } from "./orchestrator-feature-registry";
import { log, logError } from "./process-helpers";

type OpenCodeServerHandle = {
  close: () => void;
  url: string;
};

type ManagedServerFailure = {
  failedAt: number;
  loggedSuppressionAt: number | null;
  message: string;
  retryMode: "cooldown" | "disabled";
};

export interface OpenCodeAppServerOptions {
  createServer?: typeof createOpenCodeServer;
  ensureConfig?: OrchestratorReloadableModules["opencodeWorkbenchInstructions"]["ensureOpenCodeWorkbenchConfigDirectory"];
  environment?: NodeJS.ProcessEnv;
  getReloadableModules: () => OrchestratorReloadableModules;
  log?: (name: string, message: string) => void;
  logError?: (name: string, message: string) => void;
  now?: () => number;
  retryCooldownMs?: number;
  suppressionLogMs?: number;
}

const DEFAULT_RETRY_COOLDOWN_MS = 30_000;
const DEFAULT_SUPPRESSION_LOG_MS = 5_000;

function normalizePositiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeBaseUrl(value: string) {
  const parsedUrl = new URL(value);
  parsedUrl.pathname = "";
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl.toString().replace(/\/$/u, "");
}

function isMissingExecutable(message: string) {
  return /\bENOENT\b/u.test(message) && /\bopencode\b/iu.test(message);
}

function formatStartupError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return isMissingExecutable(message)
    ? `${message} Workbench could not find the OpenCode executable while starting the managed OpenCode server. Verify that \`opencode --version\` works in the Workbench dev environment, or set OPENCODE_SERVER_URL to an already-running OpenCode server.`
    : message;
}

function describeConfigMetadata(metadata: {
  hasBunLock: boolean;
  hasNodeModules: boolean;
  hasPackageJson: boolean;
  hasPackageLock: boolean;
  topLevelEntryCount: number;
} | null) {
  if (!metadata) return "no readable base config metadata";
  const notableEntries = [
    metadata.hasPackageJson ? "package.json" : null,
    metadata.hasPackageLock ? "package-lock.json" : null,
    metadata.hasBunLock ? "bun.lock" : null,
    metadata.hasNodeModules ? "node_modules" : null,
  ].filter(Boolean);
  return `${metadata.topLevelEntryCount} top-level entries${notableEntries.length ? ` (${notableEntries.join(", ")})` : ""}`;
}

export default class OpenCodeAppServer {
  private readonly createServer: typeof createOpenCodeServer;
  private readonly ensureConfig: OpenCodeAppServerOptions["ensureConfig"];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly externalServerUrl: string | null;
  private failure: ManagedServerFailure | null = null;
  private readonly hostname: string;
  private readonly log: NonNullable<OpenCodeAppServerOptions["log"]>;
  private readonly logError: NonNullable<OpenCodeAppServerOptions["logError"]>;
  private readonly now: NonNullable<OpenCodeAppServerOptions["now"]>;
  private readonly port: number;
  private readonly retryCooldownMs: number;
  private server: OpenCodeServerHandle | null = null;
  private startPromise: Promise<string> | null = null;
  private readonly suppressionLogMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenCodeAppServerOptions) {
    this.environment = options.environment ?? process.env;
    this.externalServerUrl = this.environment.OPENCODE_SERVER_URL?.trim() || null;
    this.hostname = this.environment.OPENCODE_SERVER_HOSTNAME?.trim() || "127.0.0.1";
    this.port = normalizePositiveInteger(Number.parseInt(this.environment.OPENCODE_SERVER_PORT ?? "4096", 10), 4096);
    this.timeoutMs = normalizePositiveInteger(Number.parseInt(this.environment.OPENCODE_SERVER_START_TIMEOUT_MS ?? "7000", 10), 7000);
    this.retryCooldownMs = options.retryCooldownMs ?? normalizePositiveInteger(Number.parseInt(this.environment.OPENCODE_SERVER_RETRY_COOLDOWN_MS ?? "", 10), DEFAULT_RETRY_COOLDOWN_MS);
    this.suppressionLogMs = options.suppressionLogMs ?? DEFAULT_SUPPRESSION_LOG_MS;
    this.log = options.log ?? log;
    this.logError = options.logError ?? logError;
    this.now = options.now ?? Date.now;
    this.ensureConfig = options.ensureConfig;
    this.createServer = options.createServer ?? ((async (serverOptions) => {
      const sdk = await import("@opencode-ai/sdk/v2");
      return await sdk.createOpencodeServer(serverOptions);
    }) as typeof createOpenCodeServer);
  }

  isDisabled() {
    return this.failure?.retryMode === "disabled";
  }

  async getBaseUrl() {
    if (this.externalServerUrl) return normalizeBaseUrl(this.externalServerUrl);
    if (this.server) return normalizeBaseUrl(this.server.url);
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startManagedServer();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async restart() {
    await this.startPromise?.catch(() => undefined);
    this.startPromise = null;
    if (!this.externalServerUrl) this.server?.close();
    this.server = null;
    this.failure = null;
  }

  async stop() {
    await this.startPromise?.catch(() => undefined);
    this.startPromise = null;
    if (!this.externalServerUrl) this.server?.close();
    this.server = null;
  }

  private readCooldownError() {
    if (!this.failure) return null;
    const now = this.now();
    if (this.failure.retryMode === "disabled") {
      this.logSuppression(now, "managed server startup disabled");
      return `${this.failure.message} OpenCode is optional and will stay disabled for this Workbench orchestrator process until it is restarted with a working OpenCode executable or OPENCODE_SERVER_URL.`;
    }
    const remainingMs = this.failure.failedAt + this.retryCooldownMs - now;
    if (remainingMs <= 0) {
      this.failure = null;
      return null;
    }
    this.logSuppression(now, `managed server startup retry suppressed for ${Math.ceil(remainingMs / 1000)}s`);
    return `${this.failure.message} Retry suppressed for ${Math.ceil(remainingMs / 1000)}s to avoid repeatedly rebuilding the Workbench OpenCode temp config.`;
  }

  private logSuppression(now: number, prefix: string) {
    if (!this.failure) return;
    if (this.failure.loggedSuppressionAt !== null && now - this.failure.loggedSuppressionAt < this.suppressionLogMs) return;
    this.failure.loggedSuppressionAt = now;
    this.logError("opencode-server", `${prefix}: ${this.failure.message}`);
  }

  private async startManagedServer() {
    const cooldownError = this.readCooldownError();
    if (cooldownError) throw new Error(cooldownError);
    const previousConfigDirectory = this.environment.OPENCODE_CONFIG_DIR;
    const ensureConfig = this.ensureConfig ?? this.options.getReloadableModules().opencodeWorkbenchInstructions.ensureOpenCodeWorkbenchConfigDirectory;
    const workbenchConfig = await ensureConfig({ baseConfigDirectory: previousConfigDirectory });
    this.environment.OPENCODE_CONFIG_DIR = workbenchConfig.configDirectory;
    this.log(
      "opencode-server",
      workbenchConfig.copiedBaseConfig
        ? `using Workbench OpenCode config overlay from ${workbenchConfig.baseConfigDirectory}`
        : `using Workbench OpenCode config without base config; ${workbenchConfig.baseConfigDirectory} was unavailable (${workbenchConfig.unavailableBaseConfigReason ?? "unknown"})`,
    );
    if (workbenchConfig.copiedBaseConfig) this.log("opencode-server", `copied OpenCode base config metadata: ${describeConfigMetadata(workbenchConfig.baseConfigMetadata)}`);
    try {
      const server = await this.createServer({ hostname: this.hostname, port: this.port, timeout: this.timeoutMs });
      if (!server) throw new Error("OpenCode managed server startup failed without an error.");
      this.server = server;
      this.failure = null;
      return normalizeBaseUrl(server.url);
    } catch (error) {
      const message = formatStartupError(error);
      this.failure = {
        failedAt: this.now(),
        loggedSuppressionAt: null,
        message,
        retryMode: isMissingExecutable(message) ? "disabled" : "cooldown",
      };
      this.logError("opencode-server", `managed server startup failed: ${message}`);
      throw new Error(message);
    } finally {
      if (previousConfigDirectory === undefined) delete this.environment.OPENCODE_CONFIG_DIR;
      else this.environment.OPENCODE_CONFIG_DIR = previousConfigDirectory;
    }
  }
}
