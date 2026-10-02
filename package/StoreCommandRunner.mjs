/*
 * Exports:
 * - default StoreCommandRunner: run one store lookup argv without a shell and report bounded, sanitised outcomes.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const PACKAGED_WB = path.join(path.dirname(fileURLToPath(import.meta.url)), "wb");

export default class StoreCommandRunner {
  constructor({ maxOutputBytes = MAX_OUTPUT_BYTES, packagedWb = PACKAGED_WB } = {}) {
    this.maxOutputBytes = maxOutputBytes;
    this.packagedWb = packagedWb;
  }

  /** Resolves `{ ok: true, stdout }` or `{ ok: false, reason, exitCode? }`; rejects only when `signal` aborts. */
  async run(argv, { signal } = {}) {
    signal?.throwIfAborted();
    // `wb` means this package's own bootstrap so lookups work without PATH setup.
    const [executable, ...args] = argv[0] === "wb" ? [process.execPath, this.packagedWb, ...argv.slice(1)] : argv;
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { shell: false, signal, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      const chunks = [];
      let length = 0;
      let overflow = false;
      child.stdout.on("data", chunk => {
        if (overflow) return;
        length += chunk.length;
        if (length > this.maxOutputBytes) {
          overflow = true;
          child.kill();
          return;
        }
        chunks.push(chunk);
      });
      child.once("error", error => {
        if (signal?.aborted) reject(signal.reason);
        else resolve({ ok: false, reason: error.code === "ENOENT" ? "missing-command" : "spawn-failed" });
      });
      child.once("close", exitCode => {
        if (signal?.aborted) return reject(signal.reason);
        if (overflow) return resolve({ ok: false, reason: "output-limit" });
        if (exitCode !== 0) return resolve({ ok: false, reason: "exit", exitCode });
        resolve({ ok: true, stdout: Buffer.concat(chunks).toString("utf8") });
      });
    });
  }
}
