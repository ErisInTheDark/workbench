/*
 * Exports:
 * - WorkbenchBrowserStateIdentity: optional UUID namespace plus one-time URL cleanup. Keywords: browser, state, UUID, port.
 * - resolveWorkbenchBrowserStateIdentity: resolve stable-port localStorage identity and consume a transferred UUID. Keywords: browser, state, localStorage, transfer.
 * - readWorkbenchBrowserStateTransferId: read an existing stable-port UUID for an origin move. Keywords: browser, state, port, redirect.
 */
import { isWorkbenchBrowserStateId } from "workbench-shared/state/workbench-client-state";

import type { WorkbenchAppPortClientSnapshot } from "../app/workbench-app-port-client";

const BROWSER_STATE_STORAGE_KEY = "workbench.browserStateId";
export const WORKBENCH_BROWSER_STATE_TRANSFER_PARAMETER = "workbenchBrowserStateId";

interface BrowserStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkbenchBrowserStateIdentity {
  browserStateId?: string;
  cleanedHref?: string;
}

function usesStableBrowserState(snapshot: WorkbenchAppPortClientSnapshot) {
  return snapshot.source === "environment" || snapshot.source === "setting";
}

export function resolveWorkbenchBrowserStateIdentity(
  snapshot: WorkbenchAppPortClientSnapshot,
  currentHref: string = window.location.href,
  storage?: BrowserStateStorage,
  createId: () => string = () => crypto.randomUUID(),
): WorkbenchBrowserStateIdentity {
  if (!usesStableBrowserState(snapshot)) return {};
  const stateStorage = storage ?? window.localStorage;
  const currentUrl = new URL(currentHref);
  const transferredId = currentUrl.searchParams.get(WORKBENCH_BROWSER_STATE_TRANSFER_PARAMETER);
  let browserStateId = transferredId && isWorkbenchBrowserStateId(transferredId)
    ? transferredId
    : stateStorage.getItem(BROWSER_STATE_STORAGE_KEY);
  if (!browserStateId || !isWorkbenchBrowserStateId(browserStateId)) {
    browserStateId = createId();
    if (!isWorkbenchBrowserStateId(browserStateId)) throw new Error("Generated Workbench browser state ID is invalid.");
  }
  stateStorage.setItem(BROWSER_STATE_STORAGE_KEY, browserStateId);
  if (transferredId === null) return { browserStateId };
  currentUrl.searchParams.delete(WORKBENCH_BROWSER_STATE_TRANSFER_PARAMETER);
  return { browserStateId, cleanedHref: currentUrl.toString() };
}

export function readWorkbenchBrowserStateTransferId(
  snapshot: WorkbenchAppPortClientSnapshot | null,
  storage?: Pick<BrowserStateStorage, "getItem">,
) {
  if (!snapshot || !usesStableBrowserState(snapshot)) return undefined;
  const browserStateId = (storage ?? window.localStorage).getItem(BROWSER_STATE_STORAGE_KEY);
  return browserStateId && isWorkbenchBrowserStateId(browserStateId) ? browserStateId : undefined;
}
