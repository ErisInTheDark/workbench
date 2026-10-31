/*
 * Exports:
 * - default WorkbenchVisRoutes: answer the vis origin: admit requests like the app origin does, then stream each vis
 *   page and file from the daemon that owns its session, only through daemons this app reaches.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseVisFramePath } from "workbench-shared/workbench/vis/vis-url";
import { admitsAppConnection } from "../network/app-ingress.ts";
import type WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import DaemonResponseStreams from "../workspace/DaemonResponseStreams";
import type WorkbenchDaemonSources from "../workspace/WorkbenchDaemonSources";

export default class WorkbenchVisRoutes {
  private readonly streams: DaemonResponseStreams;

  constructor(private readonly options: {
    sources: Pick<WorkbenchDaemonSources, "get">;
    network: Pick<WorkbenchNetworkController, "ingress"> | undefined;
    warn(message: string): void;
    fetcher?: typeof fetch;
  }) {
    this.streams = new DaemonResponseStreams({ warn: options.warn, fetcher: options.fetcher });
  }

  async handle(request: IncomingMessage, response: ServerResponse) {
    if (!admitsAppConnection(request, this.options.network)) {
      response.writeHead(403, { Connection: "close", "Cache-Control": "no-store" }).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://workbench.local");
    const target = parseVisFramePath(url.pathname);
    if (!target) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end();
      return;
    }
    await this.streams.stream(this.options.sources.get(target.daemonId), `${target.daemonPath}${url.search}`, request, response, "Vis page");
  }

  dispose() {
    this.streams.dispose();
  }
}
