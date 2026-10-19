/*
 * Exports:
 * - McpSignInPopup: a sign-in window that can be pointed at a provider page and closed.
 * - openCenteredMcpSignInPopup: open the centred sign-in window; must run synchronously inside a user click.
 */
export interface McpSignInPopup {
  navigate(url: string): void;
  close(): void;
}

const POPUP_WIDTH = 520;
const POPUP_HEIGHT = 720;

/** Opens synchronously inside the click, so popup blockers allow it; the provider page never gets our window. */
export function openCenteredMcpSignInPopup(): McpSignInPopup | null {
  const left = Math.round(window.screenX + Math.max(0, (window.outerWidth - POPUP_WIDTH) / 2));
  const top = Math.round(window.screenY + Math.max(0, (window.outerHeight - POPUP_HEIGHT) / 2));
  const popup = window.open("about:blank", "workbench-mcp-sign-in",
    `popup,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`);
  if (!popup) return null;
  popup.opener = null;
  return { navigate: url => { popup.location.href = url; }, close: () => popup.close() };
}
