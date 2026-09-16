/*
 * Exports:
 * - default WorkbenchTranscriptAssetController: serve immutable validated transcript image assets.
 */
import type http from "node:http";
import type WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";

const THREAD_PATTERN = /^[A-Za-z0-9_-]+$/u;
const ASSET_PATTERN = /^[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/u;

function sendJson(response: http.ServerResponse, status: number, error: string) {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error }));
}

export default class WorkbenchTranscriptAssetController {
  constructor(
    private readonly assets: Pick<WorkbenchDatabaseController, "readTranscriptAsset">,
  ) {}

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const match = /^\/daemon\/transcript-assets\/codex\/([^/]+)\/([^/]+)$/u.exec(new URL(request.url ?? "/", "http://localhost").pathname);
    const threadId = match?.[1] ?? "";
    const asset = match?.[2] ?? "";
    if (!THREAD_PATTERN.test(threadId) || !ASSET_PATTERN.test(asset)) {
      sendJson(response, 400, "Invalid transcript asset path.");
      return;
    }
    const content = await this.assets.readTranscriptAsset({ threadId, assetName: asset });
    if (content) {
      response.writeHead(200, {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": content.byteLength,
        "Content-Type": content.mimeType,
      });
      response.end(content.bytes);
      return;
    }
    sendJson(response, 404, "Transcript asset not found.");
  }
}
