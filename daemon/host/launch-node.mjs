/*
 * No exports. Wait for native crash-unit ownership before loading the service.
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

try {
  if (process.env.WORKBENCH_SERVICE_ACK_REQUIRED === "1") {
    await new Promise((resolve, reject) => {
      let input = "";
      const cleanup = () => {
        process.stdin.off("data", read);
        process.stdin.off("end", ended);
        process.stdin.off("error", failed);
        process.stdin.pause();
      };
      const failed = error => { cleanup(); reject(error); };
      const ended = () => failed(new Error("Native supervisor exited before claiming this host."));
      const read = bytes => {
        input += bytes.toString();
        if (input.length > 64) return failed(new Error("Invalid host ownership acknowledgement."));
        if (input.includes("\n")) {
          if (input !== "workbench-host-owned\n") return failed(new Error("Invalid host ownership acknowledgement."));
          cleanup();
          resolve();
        }
      };
      process.stdin.on("data", read);
      process.stdin.once("end", ended);
      process.stdin.once("error", failed);
      process.stdin.resume();
    });
  }
  if (process.platform === "linux" && process.env.WORKBENCH_SERVICE_RUNTIME) {
    const directory = process.env.WORKBENCH_SERVICE_RUNTIME;
    if (!path.isAbsolute(directory)) throw new Error("Service runtime directory must be absolute.");
    const filename = path.join(directory, "session");
    let session;
    try { session = await readFile(filename, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      session = randomUUID();
      await writeFile(filename, session, { mode: 0o600, flag: "wx" });
    }
    if (!/^[a-f0-9-]{36}$/u.test(session)) throw new Error("Service supervision session is invalid.");
    process.env.WORKBENCH_SERVICE_SESSION = session;
  }
  // createRequire handles Windows drive paths as paths, not URL schemes.
  const require = createRequire(import.meta.url);
  require("tsx/cjs");
  require("./index.ts");
} catch (error) {
  console.error(`Workbench host bootstrap failed: ${error.message}`);
  process.exitCode = 78;
}
