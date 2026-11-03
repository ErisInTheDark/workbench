/* No exports. Protect the status row's auto-open rule: new attention opens beside a running turn only when that turn waits on the user. */
import assert from "node:assert/strict";
import test from "node:test";

import { getThreadStatusAttentionAction } from "./ThreadStatusRow";

test("a running turn opens attention panels only for a thread waiting on the user", () => {
  assert.deepEqual(
    getThreadStatusAttentionAction({ busy: true, panel: "arc", whileBusy: true }),
    { kind: "open", panel: "arc" },
  );
  assert.deepEqual(
    getThreadStatusAttentionAction({ busy: false, panel: "arc", whileBusy: false }),
    { kind: "open", panel: "arc" },
  );
  // Ordinary new work waits for the turn to stop instead of stealing the view mid-run.
  assert.deepEqual(
    getThreadStatusAttentionAction({ busy: true, panel: "arc", whileBusy: false }),
    { kind: "close" },
  );
});

test("without new attention only a running turn closes what attention opened", () => {
  assert.equal(getThreadStatusAttentionAction({ busy: false, panel: null, whileBusy: false }), null);
  assert.deepEqual(getThreadStatusAttentionAction({ busy: true, panel: null, whileBusy: false }), { kind: "close" });
});
