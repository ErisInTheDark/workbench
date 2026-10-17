/*
 * No production exports. Node tests protect push, replace, back, and forward notifications and in-app link clicks at the browser navigation owner.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  installBrowserLinkNavigation,
  installBrowserNavigationEvents,
  subscribeBrowserNavigation,
  type BrowserNavigationTarget,
} from "./browser-navigation.ts";

const ORIGIN = "http://workbench.local";

type ClickPhase = "capture" | "bubble";

/** Clicks run window capture listeners, then component handlers, then window bubble listeners unless stopped. */
class FakeNavigationTarget extends EventTarget implements BrowserNavigationTarget {
  location = { origin: ORIGIN, pathname: "/", search: "" };
  pushes: string[] = [];
  components: Array<(event: Event) => void> = [];
  private readonly clickListeners: Record<ClickPhase, Set<EventListener>> = { capture: new Set(), bubble: new Set() };

  override addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions) {
    if (type === "click") this.clickListeners[options?.capture ? "capture" : "bubble"].add(listener);
    else super.addEventListener(type, listener, options);
  }

  override removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions) {
    if (type === "click") this.clickListeners[options?.capture ? "capture" : "bubble"].delete(listener);
    else super.removeEventListener(type, listener, options);
  }

  dispatchClick(event: Event) {
    for (const listener of this.clickListeners.capture) listener(event);
    for (const component of this.components) {
      if (!event.cancelBubble) component(event);
    }
    if (!event.cancelBubble) for (const listener of this.clickListeners.bubble) listener(event);
  }
  history = {
    pushState: (_data: unknown, _unused: string, url?: string | URL | null) => {
      this.pushes.push(String(url));
      this.applyUrl(url);
    },
    replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => this.applyUrl(url),
  };

  private applyUrl(url?: string | URL | null) {
    if (url === undefined || url === null) return;
    const parsed = new URL(String(url), ORIGIN);
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

type ClickInit = Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> & {
  button?: number;
  download?: boolean;
  href: string;
  prevented?: boolean;
  target?: string;
};

function click(target: FakeNavigationTarget, init: ClickInit) {
  const anchor = {
    href: new URL(init.href, ORIGIN).href,
    target: init.target ?? "",
    hasAttribute: (name: string) => name === "download" && Boolean(init.download),
  };
  const event = new Event("click", { cancelable: true });
  Object.defineProperties(event, {
    altKey: { value: init.altKey ?? false },
    button: { value: init.button ?? 0 },
    ctrlKey: { value: init.ctrlKey ?? false },
    metaKey: { value: init.metaKey ?? false },
    shiftKey: { value: init.shiftKey ?? false },
    target: { value: { closest: (selector: string) => selector === "a[href]" ? anchor : null } },
  });
  if (init.prevented) event.preventDefault();
  target.dispatchClick(event);
  return event.defaultPrevented;
}

test("plain clicks on in-app links push their href instead of reloading the document", () => {
  const target = new FakeNavigationTarget();
  const uninstall = installBrowserLinkNavigation(target);
  assert.equal(click(target, { href: "/one/+/two/@/settings?sidebar=1" }), true);
  assert.equal(click(target, { href: "/" }), true);
  assert.deepEqual(target.pushes, ["/one/+/two/@/settings?sidebar=1", "/"]);
  // The current location is already shown; the browser must not reload it either.
  assert.equal(click(target, { href: "/" }), true);
  assert.equal(target.pushes.length, 2);
  uninstall();
  assert.equal(click(target, { href: "/one/@/git" }), false);
});

test("modified, foreign, download, new-window, and component-handled clicks keep browser behaviour", () => {
  const target = new FakeNavigationTarget();
  const uninstall = installBrowserLinkNavigation(target);
  const ignored: ClickInit[] = [
    { href: "/one/@/git", ctrlKey: true },
    { href: "/one/@/git", metaKey: true },
    { href: "/one/@/git", shiftKey: true },
    { href: "/one/@/git", altKey: true },
    { href: "/one/@/git", button: 1 },
    { href: "/one/@/git", target: "_blank" },
    { href: "/one/@/git", download: true },
    { href: "/one/@/git", prevented: true },
    { href: "https://example.com/one/@/git" },
    { href: "/api/workspace/assets/file.png" },
    { href: "/agent/thread" },
  ];
  for (const init of ignored) {
    assert.equal(click(target, init), Boolean(init.prevented), JSON.stringify(init));
  }
  assert.deepEqual(target.pushes, []);
  uninstall();
});

test("components that handle a link keep it, while links inside click-stopping surfaces still navigate", () => {
  const target = new FakeNavigationTarget();
  const uninstall = installBrowserLinkNavigation(target);
  const seenPrevented: boolean[] = [];
  target.components = [event => {
    seenPrevented.push(event.defaultPrevented);
    event.preventDefault();
  }];
  assert.equal(click(target, { href: "/one/@/thread/t1/sub/t2" }), true);
  assert.deepEqual(seenPrevented, [false]);
  assert.deepEqual(target.pushes, []);

  target.components = [event => event.stopPropagation(), () => assert.fail("stopped clicks reach no outer handler")];
  assert.equal(click(target, { href: "/one/@/thread/t1" }), true);
  target.components = [event => event.stopImmediatePropagation()];
  assert.equal(click(target, { href: "/one/@/git" }), true);
  assert.deepEqual(target.pushes, ["/one/@/thread/t1", "/one/@/git"]);
  uninstall();
});
