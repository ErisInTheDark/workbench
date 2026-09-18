/* No exports. Protect connection handoff routes and one-time receipt consumption. */
import assert from "node:assert/strict";
import test from "node:test";
import { networkNavigationUrl, consumeNetworkHandoff } from "./workbench-network-navigation";

test("origin handoff preserves route, query, fragment and browser identity", () => {
  const receipt = { token: "d479a147-899e-4332-8855-7b219e652aab", returning: false };
  const url = networkNavigationUrl("https://desktop.wb.inthedark.boo/project/thread?view=settings#network", "http://100.80.0.2:8089", receipt, "a902ec77-c99c-4316-9b10-5581f55801e8");
  const consumed = consumeNetworkHandoff(url);
  assert.deepEqual(consumed.receipt, receipt);
  const clean = new URL(consumed.href);
  assert.equal(clean.origin, "http://100.80.0.2:8089");
  assert.equal(clean.pathname, "/project/thread");
  assert.equal(clean.searchParams.get("view"), "settings");
  assert.equal(clean.searchParams.get("workbenchBrowserStateId"), "a902ec77-c99c-4316-9b10-5581f55801e8");
  assert.equal(clean.hash, "#network");
  assert.equal(consumeNetworkHandoff(consumed.href).receipt, null);
});

test("handoff rejects non-origin destinations and malformed receipts", () => {
  assert.throws(() => networkNavigationUrl("http://127.0.0.1:4200/launch", "https://example.com/path"), /origin/i);
  assert.throws(() => networkNavigationUrl("http://127.0.0.1:4200/launch", "javascript:alert(1)"), /origin/i);
  assert.throws(() => consumeNetworkHandoff("http://127.0.0.1:4200/?workbenchNetworkHandoff=invalid"), /handoff/i);
});

test("an upgrade survives an intermediate handoff and is consumed once after completion", () => {
  const receipt = { token: "d479a147-899e-4332-8855-7b219e652aab", returning: false, upgrade: "tailnet-service" as const };
  const url = networkNavigationUrl("https://desktop.wb.inthedark.boo/settings", "http://127.0.0.1:4200", receipt);
  const consumed = consumeNetworkHandoff(url);
  assert.deepEqual(consumed.receipt, receipt);
  assert.equal(consumeNetworkHandoff(consumed.href).receipt, null);
  const completed = networkNavigationUrl(consumed.href, "http://127.0.0.1:4300", undefined, undefined, receipt.upgrade);
  const next = consumeNetworkHandoff(completed);
  assert.equal(next.upgrade, "tailnet-service");
  assert.equal(consumeNetworkHandoff(next.href).upgrade, null);
});
