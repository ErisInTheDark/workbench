/* No production exports. Protect lifetime streams and terminal shutdown admission. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import WorkbenchAppLifetime from "./WorkbenchAppLifetime";

test("app lifetime retains streams until shutdown and rejects late consumers", () => {
  const owner = new WorkbenchAppLifetime();
  const responses: { status: number; ended: boolean }[] = [];
  const attach = (method: string) => {
    const state = { status: 0, ended: false };
    responses.push(state);
    const response = Object.assign(new EventEmitter(), {
      writeHead(status: number) { state.status = status; },
      write() {},
      end() { state.ended = true; },
    });
    owner.handle({ method } as IncomingMessage, response as unknown as ServerResponse);
    return state;
  };
  const stream = attach("GET");
  const probe = attach("HEAD");
  assert.equal(stream.ended, false);
  assert.equal(probe.ended, true);
  owner.close();
  assert.equal(stream.ended, true);
  assert.equal(attach("GET").status, 503);
});
