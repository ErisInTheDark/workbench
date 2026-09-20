/*
 * Exports:
 * - WorkbenchOpenCodeClient: typed client for the user's companion-capable shared OpenCode service.
 * - OpenCodeServiceControllerOptions: injectable service discovery and client construction.
 * - default OpenCodeServiceController: own one companion-injected service using the user's OpenCode data.
 */
import type { OpenCodeClient } from "@opencode/client";
import type { Endpoint, EnsureOptions, StopOptions } from "@opencode/client/service";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import resolveWorkbenchDataRoot from "workbench-shared/workbench-data-root";

export type WorkbenchOpenCodeClient = OpenCodeClient;

export interface OpenCodeServiceControllerOptions {
  ensureService?: (options?: EnsureOptions) => Promise<Endpoint>;
  stopService?: (options?: StopOptions) => Promise<void>;
  prepareServiceDirectory?: (directory: string) => Promise<void>;
  createClient?: (endpoint: Endpoint) => WorkbenchOpenCodeClient;
  environment?: NodeJS.ProcessEnv;
  pluginSource?: string;
  warn?: (message: string) => void;
}

function serviceEnvironment(
  environment: NodeJS.ProcessEnv,
  pluginSource: string,
  serviceStateHome: string,
): Record<string, string> {
  const existing = environment.OPENCODE_CONFIG_CONTENT?.trim();
  let config: Record<string, unknown> = {};
  if (existing) {
    const parsed: unknown = JSON.parse(existing);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OPENCODE_CONFIG_CONTENT must contain a JSON object.");
    }
    config = { ...parsed as Record<string, unknown> };
  }
  const configured = Array.isArray(config.plugins) ? config.plugins : [];
  config.$schema = typeof config.$schema === "string" ? config.$schema : "https://opencode.ai/config.json";
  config.plugins = [...configured.filter(entry => entry !== pluginSource), pluginSource];
  return {
    ...(environment.OPENCODE_CONFIG_DIR ? { OPENCODE_CONFIG_DIR: environment.OPENCODE_CONFIG_DIR } : {}),
    ...(environment.OPENCODE_DB ? { OPENCODE_DB: environment.OPENCODE_DB } : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    WORKBENCH_DATA_ROOT: resolveWorkbenchDataRoot({ environment }),
    XDG_STATE_HOME: serviceStateHome,
  };
}

async function awaitWhileActive<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      value => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function companionFailure(
  plugins: Awaited<ReturnType<WorkbenchOpenCodeClient["plugin"]["list"]>>["data"],
  configured: boolean | null,
) {
  const states = [...plugins].sort((left, right) => {
    const priority = (plugin: typeof left) => plugin.id === "workbench"
      ? 0 : plugin.state.status === "failed" ? 1 : 2;
    return priority(left) - priority(right);
  }).slice(0, 10).map(plugin => {
    const id = plugin.id?.slice(0, 80) ?? "unnamed";
    const state = plugin.state.status === "failed"
      ? `failed:${plugin.state.error.slice(0, 160)}` : plugin.state.status;
    return `${id}=${state}`;
  }).join(", ");
  return new Error(
    `OpenCode Workbench companion did not load in its dedicated service `
    + `(configured: ${configured === null ? "unknown" : configured}; plugins: ${states || "none"}).`,
  );
}

async function waitForCompanion(
  client: WorkbenchOpenCodeClient,
  pluginSource: string,
  signal: AbortSignal,
  warn: (message: string) => void,
) {
  const read = async () => {
    signal.throwIfAborted();
    const plugins = await client.plugin.list({}, { signal });
    const companion = plugins.data.find(plugin => plugin.id === "workbench");
    if (companion?.state.status === "active") return true;
    if (companion?.state.status === "failed") throw companionFailure(plugins.data, true);
    return false;
  };
  if (await read()) return;
  const configured = await client.config.get({}, { signal }).then(entries => entries.some(entry =>
    entry.type === "document" && entry.info.plugins?.some(plugin =>
      typeof plugin === "string" ? plugin === pluginSource : plugin.package === pluginSource,
    ),
  )).catch(error => {
    const message = error instanceof Error ? error.message : "unknown failure";
    warn(`OpenCode companion configuration could not be inspected: ${message.slice(0, 200)}`);
    return null;
  });
  if (configured === false) throw companionFailure([], false);
  const events = client.event.subscribe({ signal });
  if (await read()) return;
  for await (const event of events) {
    signal.throwIfAborted();
    if (event.type === "plugin.updated" && await read()) return;
  }
  throw companionFailure((await client.plugin.list()).data, configured);
}

export default class OpenCodeServiceController {
  private client: WorkbenchOpenCodeClient | null = null;
  private acquiring: Promise<WorkbenchOpenCodeClient> | null = null;
  private active = false;
  private stopService: ((options?: StopOptions) => Promise<void>) | null = null;
  private readonly lifetime = new AbortController();
  private disposed = false;
  private readonly serviceStateHome: string;
  private readonly serviceFile: string;

  constructor(private readonly options: OpenCodeServiceControllerOptions = {}) {
    const dataRoot = resolveWorkbenchDataRoot({ environment: options.environment ?? process.env });
    this.serviceStateHome = path.join(dataRoot, "daemon", "providers", "opencode", "state");
    this.serviceFile = path.join(this.serviceStateHome, "opencode", "service.json");
  }

  async acquire(signal?: AbortSignal): Promise<WorkbenchOpenCodeClient> {
    if (this.disposed) throw new Error("OpenCode service client has been disposed.");
    if (this.client) return this.client;
    const acquiring = this.acquiring ??= this.create().finally(() => {
      this.acquiring = null;
    });
    return await awaitWhileActive(acquiring, signal);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort(new Error("OpenCode service controller disposed."));
    this.client = null;
    this.acquiring = null;
    await this.stopOwnedService();
  }

  private async create() {
    const [{ OpenCode }, { Service }] = await Promise.all([
      import("@opencode/client"),
      import("@opencode/client/service"),
    ]);
    const pluginSource = this.options.pluginSource
      ?? fileURLToPath(new URL("./workbench-plugin", import.meta.url));
    this.stopService = this.options.stopService ?? Service.stop;
    await (this.options.prepareServiceDirectory ?? (directory => mkdir(directory, { recursive: true })))(
      path.dirname(this.serviceFile),
    );
    try {
      const endpoint = await (this.options.ensureService ?? Service.ensure)({
        command: ["opencode", "serve", "--service", "--port", "0"],
        env: serviceEnvironment(this.options.environment ?? process.env, pluginSource, this.serviceStateHome),
        file: this.serviceFile,
        onStart: () => {
          this.active = true;
        },
        version: version => version.startsWith("2."),
      });
      this.active = true;
      const createClient = this.options.createClient ?? ((value: Endpoint) => OpenCode.make({
        baseUrl: value.url,
        headers: Service.headers(value),
      }));
      const client = createClient(endpoint);
      await waitForCompanion(
        client,
        pluginSource,
        this.lifetime.signal,
        this.options.warn ?? (message => console.warn(message)),
      );
      if (this.disposed) throw new Error("OpenCode service client was disposed during acquisition.");
      return this.client = client;
    } catch (error) {
      try {
        await this.stopOwnedService();
      } catch (stopError) {
        throw new AggregateError([error, stopError], "OpenCode service acquisition and cleanup both failed.");
      }
      throw error;
    }
  }

  private async stopOwnedService() {
    if (!this.active) return;
    this.active = false;
    await this.stopService?.({ file: this.serviceFile, pty: "handoff" });
  }
}
