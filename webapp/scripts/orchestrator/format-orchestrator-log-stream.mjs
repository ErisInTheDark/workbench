/*
 * Exports:
 * - OrchestratorLogLineFormatter: timestamp each decoded physical line while preserving blank lines, chunk boundaries, and a final unterminated fragment. Keywords: orchestrator, log, timestamp, stream.
 */
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import { pathToFileURL } from "node:url";

function shortTimestamp(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

export class OrchestratorLogLineFormatter extends Transform {
  #buffer = "";
  #decoder = new StringDecoder("utf8");
  #now;

  constructor({ now = shortTimestamp } = {}) {
    super();
    this.#now = now;
  }

  _transform(chunk, _encoding, callback) {
    this.#buffer += this.#decoder.write(chunk);
    this.#emitCompleteLines();
    callback();
  }

  _flush(callback) {
    this.#buffer += this.#decoder.end();
    this.#emitCompleteLines();
    if (this.#buffer.length > 0) {
      this.push(`[${this.#now()}] ${this.#buffer}\n`);
      this.#buffer = "";
    }
    callback();
  }

  #emitCompleteLines() {
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.push(`[${this.#now()}] ${line}\n`);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      newlineIndex = this.#buffer.indexOf("\n");
    }
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryUrl === import.meta.url) {
  const formatter = new OrchestratorLogLineFormatter();
  let failed = false;
  const fail = (error) => {
    if (failed) return;
    failed = true;
    const message = (error instanceof Error ? error.message : String(error)).replaceAll("\r", "\\r").replaceAll("\n", "\\n").slice(0, 512);
    process.stderr.write(`[${shortTimestamp()}] Orchestrator log formatter failed: ${message}\n`);
    process.exitCode = 1;
  };
  process.stdin.on("error", fail);
  formatter.on("error", fail);
  process.stdout.on("error", fail);
  process.stdin.pipe(formatter).pipe(process.stdout);
}
