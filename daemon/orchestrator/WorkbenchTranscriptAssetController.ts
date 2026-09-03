/*
 * Exports:
 * - default WorkbenchTranscriptAssetController: serve immutable validated transcript image assets. Keywords: transcript, asset, image, http.
 */
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";

const THREAD_PATTERN = /^[A-Za-z0-9_-]+$/u;
const ASSET_PATTERN = /^[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/u;

function contentType(asset: string) {
  if (asset.endsWith(".jpg")) return "image/jpeg";
  if (asset.endsWith(".webp")) return "image/webp";
  if (asset.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function sendJson(response: http.ServerResponse, status: number, error: string) {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error }));
}

export default class WorkbenchTranscriptAssetController {
  constructor(private readonly storageRoot: string) {}

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const match = /^\/orchestrator\/transcript-assets\/codex\/([^/]+)\/([^/]+)$/u.exec(new URL(request.url ?? "/", "http://localhost").pathname);
    const threadId = match?.[1] ?? "";
    const asset = match?.[2] ?? "";
    if (!THREAD_PATTERN.test(threadId) || !ASSET_PATTERN.test(asset)) {
      sendJson(response, 400, "Invalid transcript asset path.");
      return;
    }
    const root = path.resolve(this.storageRoot, ".workbench", "transcripts", "codex", "threads", threadId, "assets");
    const target = path.resolve(root, asset);
    if (!target.startsWith(`${root}${path.sep}`)) {
      sendJson(response, 400, "Invalid transcript asset path.");
      return;
    }
    try {
      const bytes = await fs.readFile(target);
      response.writeHead(200, {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": bytes.length,
        "Content-Type": contentType(asset),
      });
      response.end(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendJson(response, 404, "Transcript asset not found.");
        return;
      }
      throw error;
    }
  }
}
