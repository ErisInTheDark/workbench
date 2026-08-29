/*
 * No production exports. Node tests protect push, replace, back, and forward notifications at the browser navigation owner.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  installBrowserNavigationEvents,
  subscribeBrowserNavigation,
  type BrowserNavigationTarget,
} from "./browser-navigation.ts";

class FakeNavigationTarget extends EventTarget implements BrowserNavigationTarget {
  location = { pathname: "/", search: "" };
  history = {
    pushState: (_data: unknown, _unused: string, url?: string | URL | null) => this.applyUrl(url),
    replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => this.applyUrl(url),
  };

  private applyUrl(url?: string | URL | null) {
    if (url === undefined || url === null) return;
    const parsed = new URL(String(url), "http://workbench.local");
    this.location.pathname = parsed.pathname;
    this.location.search = parsed.search;
  }

  pop(url: string) {
    this.applyUrl(url);
    this.dispatchEvent(new Event("popstate"));
  }
}

test("publishes push, replace, back, and forward navigation through one subscription", () => {
  const target = new FakeNavigationTarget();
  const uninstall = installBrowserNavigationEvents(target);
  const snapshots: string[] = [];
  const unsubscribe = subscribeBrowserNavigation(() => {
    snapshots.push(`${target.location.pathname}${target.location.search}`);
  }, target);

  target.history.pushState({}, "", "/alpha?view=file");
  target.history.replaceState({}, "", "/beta");
  target.pop("/alpha?view=file");
  target.pop("/beta");

  assert.deepEqual(snapshots, [
    "/alpha?view=file",
    "/beta",
    "/alpha?view=file",
    "/beta",
  ]);

  unsubscribe();
  uninstall();
  target.history.pushState({}, "", "/ignored");
  assert.equal(snapshots.length, 4);
});
