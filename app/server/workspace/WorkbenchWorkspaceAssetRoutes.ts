/*
 * Exports:
 * - default WorkbenchWorkspaceAssetRoutes: stream recognised daemon assets through the authenticated app origin.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import DaemonResponseStreams from "./DaemonResponseStreams";
import type WorkbenchDaemonSources from "./WorkbenchDaemonSources";

export default class WorkbenchWorkspaceAssetRoutes {
  private readonly streams: DaemonResponseStreams;

  constructor(private readonly options: {
    sources: WorkbenchDaemonSources;
    warn(message: string): void;
    fetcher?: typeof fetch;
  }) {
    this.streams = new DaemonResponseStreams({ warn: options.warn, fetcher: options.fetcher });
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (!url.pathname.startsWith("/api/workspace/assets/")) return false;
    const match = /^\/api\/workspace\/assets\/([^/]+)(\/daemon\/(?:project-icons\/[^/]+|transcript-assets\/(?:[^/]+\/){1,2}[a-f0-9]{64}\.(?:png|jpg|jpeg|webp|gif)))$/u.exec(url.pathname);
    const id = DaemonIdSchema.safeParse(match?.[1]);
    if (!match || !id.success || request.method !== "GET") {
      response.writeHead(400).end();
      return true;
    }
    await this.streams.stream(this.options.sources.get(id.data), `${match[2]}${url.search}`, request, response, "Workspace asset");
    return true;
  }

  dispose() {
    this.streams.dispose();
  }
}
