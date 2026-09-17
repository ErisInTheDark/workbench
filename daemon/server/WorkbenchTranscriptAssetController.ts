/*
 * Exports:
 * - default WorkbenchTranscriptAssetController: serve immutable validated transcript image assets.
 */
import type http from "node:http";
import type WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import { parseTranscriptAssetAddress } from "workbench-shared/workbench/transcript/transcript-asset-address";

function sendJson(response: http.ServerResponse, status: number, error: string) {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error }));
}

export default class WorkbenchTranscriptAssetController {
  constructor(
    private readonly assets: Pick<WorkbenchDatabaseController, "readTranscriptAsset">,
  ) {}

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const address = parseTranscriptAssetAddress(new URL(request.url ?? "/", "http://localhost").pathname);
    if (!address || address.surface !== "daemon") {
      sendJson(response, 400, "Invalid transcript asset path.");
      return;
    }
    const content = await this.assets.readTranscriptAsset({ threadId: address.threadId, assetName: address.assetName });
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
