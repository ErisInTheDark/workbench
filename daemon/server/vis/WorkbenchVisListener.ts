/*
 * Exports:
 * - default WorkbenchVisListener: own the daemon's loopback-only vis listener, where its headless checks load served
 *   vis pages on an origin that reaches no daemon API.
 */
import type http from "node:http";
import HttpServer from "workbench-shared/http/HttpServer";
import { isLoopbackConnection } from "workbench-shared/http/loopback-connection";

export default class WorkbenchVisListener {
  readonly #server: HttpServer;
  #origin: string | null = null;

  constructor(handle: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>, log: (message: string) => void) {
    this.#server = new HttpServer({
      hostname: "127.0.0.1",
      handleRequest: async (request, response) => {
        if (!isLoopbackConnection(request.socket)) {
          response.writeHead(403, { Connection: "close" }).end();
          return;
        }
        await handle(request, response);
      },
      onError: error => log(`Vis listener failed: ${error.message.slice(0, 500)}`),
    });
  }

  /** Null until listening, and again once closed. */
  origin() {
    return this.#origin;
  }

  async start() {
    this.#origin = (await this.#server.start()).url;
  }

  async close() {
    this.#origin = null;
    await this.#server.close({ force: true });
  }
}
