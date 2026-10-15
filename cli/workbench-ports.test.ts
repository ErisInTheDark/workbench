/* No production exports. Tests active listener discovery and plain-text port rendering. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { renderWorkbenchPorts, workbenchPorts } from "./workbench-ports.ts";

test("lists active Workbench listeners by numeric port", () => {
  assert.deepEqual(workbenchPorts({
    appOrigin: "http://127.0.0.1:5173",
    daemonOrigin: "http://127.0.0.1:61974",
    hostOrigin: "http://127.0.0.1:61973",
  }), [
    { port: 5_173, domain: "app", protocol: "http/ws" },
    { port: 61_973, domain: "host", protocol: "http/ws" },
    { port: 61_974, domain: "daemon", protocol: "http/ws" },
  ]);
});

test("omits unavailable app and daemon listeners", () => {
  assert.deepEqual(workbenchPorts({
    appOrigin: null,
    daemonOrigin: null,
    hostOrigin: "http://127.0.0.1:61973",
  }), [
    { port: 61_973, domain: "host", protocol: "http/ws" },
  ]);
});

test("renders a human-readable table rather than JSON", () => {
  const rendered = renderWorkbenchPorts([
    { port: 5_173, domain: "app", protocol: "http/ws" },
    { port: 61_973, domain: "host", protocol: "http/ws" },
  ]);

  assert.doesNotMatch(rendered.trimStart(), /^[{[]/u);
  assert.match(rendered, /port\s+domain\s+protocol/u);
  assert.match(rendered, /5173\s+app\s+http\/ws/u);
  assert.match(rendered, /61973\s+host\s+http\/ws/u);
});

test("checkout ports dispatch does not require Vite+", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await promisify(execFile)(process.execPath, [path.join(root, "cli/dispatch.mjs"), "ports"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      PATH: "",
      WORKBENCH_DATA_ROOT: path.join(root, ".workbench", "tmp", `ports-empty-${process.pid}`),
    },
  });
  assert.equal(result.stderr, "");
});
