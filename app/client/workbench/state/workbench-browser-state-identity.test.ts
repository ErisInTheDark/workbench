/*
 * No production exports. Tests protect stable-port UUID persistence, random-port storage isolation, and one-time origin transfer. Keywords: browser, state, UUID, port.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchAppPortClientSnapshot } from "../app/workbench-app-port-client";
import {
  readWorkbenchBrowserStateTransferId,
  resolveWorkbenchBrowserStateIdentity,
} from "./workbench-browser-state-identity";

const FIRST_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_ID = "20000000-0000-4000-8000-000000000002";

function snapshot(source: "environment" | "random" | "setting" | "unavailable"): WorkbenchAppPortClientSnapshot {
  return {
    appOrigin: "http://127.0.0.1:43210",
    currentPort: 43_210,
    editable: source === "random" || source === "setting",
    source,
  } as WorkbenchAppPortClientSnapshot;
}

test("random and unavailable ports never access UUID storage", () => {
  const storage = {
    getItem: () => { throw new Error("storage accessed"); },
    setItem: () => { throw new Error("storage accessed"); },
  };
  assert.deepEqual(resolveWorkbenchBrowserStateIdentity(snapshot("random"), "http://127.0.0.1:43210/", storage), {});
  assert.deepEqual(resolveWorkbenchBrowserStateIdentity(snapshot("unavailable"), "http://127.0.0.1:43210/", storage), {});
  assert.equal(readWorkbenchBrowserStateTransferId(snapshot("random"), storage), undefined);
  assert.equal(readWorkbenchBrowserStateTransferId(snapshot("random")), undefined);
});

test("stable ports generate once, reuse storage, and consume a transferred UUID", () => {
  let stored: string | null = null;
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
  };
  assert.deepEqual(
    resolveWorkbenchBrowserStateIdentity(snapshot("setting"), "http://127.0.0.1:43210/project", storage, () => FIRST_ID),
    { browserStateId: FIRST_ID },
  );
  assert.equal(resolveWorkbenchBrowserStateIdentity(
    snapshot("setting"),
    "http://127.0.0.1:43210/project",
    storage,
    () => SECOND_ID,
  ).browserStateId, FIRST_ID);

  const transferred = resolveWorkbenchBrowserStateIdentity(
    snapshot("setting"),
    `http://127.0.0.1:43211/project?panel=app&workbenchBrowserStateId=${SECOND_ID}#port`,
    storage,
  );
  assert.equal(transferred.browserStateId, SECOND_ID);
  assert.equal(transferred.cleanedHref, "http://127.0.0.1:43211/project?panel=app#port");
  assert.equal(stored, SECOND_ID);
});
