/*
 * Exports:
 * - McpServerSettingsState: MCP server settings presentation state, including whether this browser can sign in.
 * - McpSignInPopup/openCenteredMcpSignInPopup: the sign-in popup window edge.
 * - default McpServerSettingsController: own one daemon's MCP server settings reads, fenced writes and OAuth sign-in starts.
 */
import type {
  McpServerSettingsSnapshot, McpServerSettingsUpdate, McpServerSignInStartParams, McpServerSignInStartResult,
} from "workbench-shared/workbench/mcp/mcp-server-settings";

export interface McpServerSettingsState {
  settings: McpServerSettingsSnapshot | null;
  /** The app's loopback origin when this browser runs on the app's machine; sign-in callbacks only reach it from there. */
  loopbackOrigin: string | null;
  busy: boolean;
  error: string;
}

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

export default class McpServerSettingsController {
  private snapshot: McpServerSettingsState = { settings: null, loopbackOrigin: null, busy: false, error: "" };
  private readonly listeners = new Set<() => void>();
  private readonly stopSignInEvents: () => void;
  private generation = 0;
  private disposed = false;

  constructor(private readonly port: {
    daemonId: string;
    read(): Promise<McpServerSettingsSnapshot>;
    update(update: McpServerSettingsUpdate): Promise<McpServerSettingsSnapshot>;
    startSignIn(params: McpServerSignInStartParams): Promise<McpServerSignInStartResult>;
    readAppPort(): Promise<{ appOrigin: string; loopbackReachable?: boolean }>;
    /** App-server announcements that a sign-in callback for this daemon finished. */
    onSignIn(listener: () => void): () => void;
    openPopup(): McpSignInPopup | null;
  }) {
    this.stopSignInEvents = port.onSignIn(() => { void this.refresh(); });
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  refresh() {
    void this.port.readAppPort().then(appPort => {
      if (!this.disposed) this.publish({ ...this.snapshot, loopbackOrigin: appPort.loopbackReachable === true ? appPort.appOrigin : null });
    }, () => {
      if (!this.disposed) this.publish({ ...this.snapshot, loopbackOrigin: null });
    });
    return this.perform(() => this.port.read());
  }

  /** Resolves true when the daemon accepted the change. */
  update(update: McpServerSettingsUpdate) { return this.perform(() => this.port.update(update)); }

  /** Open the popup first (still inside the click), then point it at the provider's login. */
  async startSignIn(id: string) {
    const origin = this.snapshot.loopbackOrigin;
    if (this.disposed || !origin) return;
    const popup = this.port.openPopup();
    if (!popup) {
      this.publish({ ...this.snapshot, error: "The browser blocked the sign-in window. Allow popups for Workbench and try again." });
      return;
    }
    this.publish({ ...this.snapshot, busy: true, error: "" });
    try {
      const redirectUri = new URL(`/api/mcp-sign-in/${encodeURIComponent(this.port.daemonId)}`, origin).href;
      const { authorizationUrl } = await this.port.startSignIn({ id, redirectUri });
      if (this.disposed) return popup.close();
      popup.navigate(authorizationUrl);
      this.publish({ ...this.snapshot, busy: false });
    } catch (error) {
      popup.close();
      if (!this.disposed) {
        this.publish({ ...this.snapshot, busy: false, error: error instanceof Error ? error.message.slice(0, 300) : "Sign-in couldn't start." });
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.stopSignInEvents();
    this.listeners.clear();
  }

  private async perform(operation: () => Promise<McpServerSettingsSnapshot>) {
    if (this.disposed) return false;
    // The newest request owns the snapshot; an older reply never overwrites it.
    const generation = ++this.generation;
    this.publish({ ...this.snapshot, busy: true, error: "" });
    try {
      const settings = await operation();
      if (!this.disposed && generation === this.generation) this.publish({ ...this.snapshot, settings, busy: false, error: "" });
      return true;
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.publish({ ...this.snapshot, busy: false, error: error instanceof Error ? error.message.slice(0, 300) : "MCP server settings failed." });
      }
      return false;
    }
  }

  private publish(snapshot: McpServerSettingsState) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
