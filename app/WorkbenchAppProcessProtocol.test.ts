/*
 * No production exports. Node tests protect structured desktop startup state, bounded command rejection, and one-owner Quit.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import WorkbenchAppProcessProtocol from "./WorkbenchAppProcessProtocol.ts";

test("announces structured loopback readiness", () => {
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => {
    written += chunk.toString();
  });
  const protocol = new WorkbenchAppProcessProtocol({
    input: new PassThrough(),
    onQuit: async () => {},
    output,
  });
  protocol.announceReady("http://127.0.0.1:43210");
  assert.equal(
    written,
    '\u001eWORKBENCH_DESKTOP_V1 {"appOrigin":"http://127.0.0.1:43210","type":"ready","version":1}\n',
  );
});

test("announces an existing app owner without scraping human logs", () => {
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => {
    written += chunk.toString();
  });
  const protocol = new WorkbenchAppProcessProtocol({
    input: new PassThrough(),
    onQuit: async () => {},
    output,
  });
  protocol.announceAlreadyRunning();
  assert.equal(
    written,
    '\u001eWORKBENCH_DESKTOP_V1 {"type":"alreadyRunning","version":1}\n',
  );
});

test("routes repeated desktop Quit commands to one lifecycle owner", async () => {
  const input = new PassThrough();
  let quitCount = 0;
  const protocol = new WorkbenchAppProcessProtocol({
    input,
    onQuit: async () => {
      quitCount += 1;
    },
  });
  protocol.start();
  input.write('{"type":"quit","version":1}\n{"type":"quit","version":1}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitCount, 1);
  protocol.dispose();
});

test("surfaces malformed and unsupported desktop commands", async () => {
  const diagnostics: string[] = [];
  const input = new PassThrough();
  const protocol = new WorkbenchAppProcessProtocol({
    input,
    onDiagnostic: (message) => diagnostics.push(message),
    onQuit: async () => {},
  });
  protocol.start();
  input.write('nope\n{"type":"restart","version":1}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(diagnostics, [
    "Desktop process protocol rejected malformed JSON.",
    "Desktop process protocol rejected an unsupported command.",
  ]);
  protocol.dispose();
});
