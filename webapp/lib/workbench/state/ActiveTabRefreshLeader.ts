/*
 * Exports:
 * - default ActiveTabRefreshLeader: elect one visible Workbench tab to own auto-refresh polling. Keywords: workbench, tabs, polling, leader.
 */

const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
const DEFAULT_LEADER_TTL_MS = 4000;
const STORAGE_EVENT_KEY = "storage";
const VISIBILITY_EVENT_KEY = "visibilitychange";

type LeaderRecord = {
  focused: boolean;
  heartbeatAt: number;
  tabId: string;
  visible: boolean;
};

type ActiveTabRefreshLeaderOptions = {
  heartbeatIntervalMs?: number;
  leaderTtlMs?: number;
  onLeadershipChange: (isLeader: boolean) => void;
  storageKey: string;
};

function createTabId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function now() {
  return Date.now();
}

function isVisible() {
  return document.visibilityState === "visible";
}

function isFocused() {
  return document.hasFocus();
}

function parseLeaderRecord(value: string | null): LeaderRecord | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<LeaderRecord>;
    return typeof parsed.tabId === "string"
      && typeof parsed.heartbeatAt === "number"
      && typeof parsed.visible === "boolean"
      && typeof parsed.focused === "boolean"
      ? {
        focused: parsed.focused,
        heartbeatAt: parsed.heartbeatAt,
        tabId: parsed.tabId,
        visible: parsed.visible,
      }
      : null;
  } catch {
    return null;
  }
}

function stringifyLeaderRecord(record: LeaderRecord) {
  return JSON.stringify(record);
}

export default class ActiveTabRefreshLeader {
  private readonly heartbeatIntervalMs: number;
  private readonly leaderTtlMs: number;
  private readonly onLeadershipChange: (isLeader: boolean) => void;
  private readonly storageKey: string;
  private readonly tabId = createTabId();
  private broadcastChannel: BroadcastChannel | null = null;
  private disposed = false;
  private heartbeatTimer: number | null = null;
  private isLeader = false;

  constructor({
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    leaderTtlMs = DEFAULT_LEADER_TTL_MS,
    onLeadershipChange,
    storageKey,
  }: ActiveTabRefreshLeaderOptions) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.leaderTtlMs = leaderTtlMs;
    this.onLeadershipChange = onLeadershipChange;
    this.storageKey = storageKey;
    this.bindBroadcastChannel();
    window.addEventListener("focus", this.handleWindowStateChange);
    window.addEventListener("blur", this.handleWindowStateChange);
    document.addEventListener(VISIBILITY_EVENT_KEY, this.handleWindowStateChange);
    window.addEventListener(STORAGE_EVENT_KEY, this.handleStorageEvent);
    this.startHeartbeat();
    this.electWithJitter();
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.releaseLeadership();
    window.removeEventListener("focus", this.handleWindowStateChange);
    window.removeEventListener("blur", this.handleWindowStateChange);
    document.removeEventListener(VISIBILITY_EVENT_KEY, this.handleWindowStateChange);
    window.removeEventListener(STORAGE_EVENT_KEY, this.handleStorageEvent);
    this.broadcastChannel?.close();
    this.broadcastChannel = null;
  }

  get current() {
    return this.isLeader;
  }

  requestElection() {
    this.electWithJitter();
  }

  private bindBroadcastChannel() {
    try {
      this.broadcastChannel = new BroadcastChannel("workbench:auto-refresh-leader");
      this.broadcastChannel.onmessage = () => {
        this.electWithJitter();
      };
    } catch {
      this.broadcastChannel = null;
    }
  }

  private startHeartbeat() {
    this.heartbeatTimer = window.setInterval(() => {
      this.elect();
    }, this.heartbeatIntervalMs);
  }

  private handleWindowStateChange = () => {
    this.electWithJitter();
  };

  private handleStorageEvent = (event: StorageEvent) => {
    if (event.key === this.storageKey) {
      this.electWithJitter();
    }
  };

  private electWithJitter() {
    const jitterMs = Math.floor(Math.random() * 80);
    window.setTimeout(() => {
      this.elect();
    }, jitterMs);
  }

  private readLeader() {
    try {
      return parseLeaderRecord(window.localStorage.getItem(this.storageKey));
    } catch {
      return null;
    }
  }

  private writeLeader(record: LeaderRecord) {
    try {
      window.localStorage.setItem(this.storageKey, stringifyLeaderRecord(record));
      return true;
    } catch {
      return false;
    }
  }

  private removeLeader() {
    try {
      const current = this.readLeader();
      if (current?.tabId === this.tabId) {
        window.localStorage.removeItem(this.storageKey);
      }
    } catch {
      // Ignore storage cleanup failures; disposal should not break the page.
    }
  }

  private shouldTakeLeadership(current: LeaderRecord | null, timestamp: number) {
    if (!isVisible()) {
      return false;
    }

    if (!current || timestamp - current.heartbeatAt > this.leaderTtlMs) {
      return true;
    }

    if (current.tabId === this.tabId) {
      return true;
    }

    const focused = isFocused();
    if (focused && (!current.visible || !current.focused)) {
      return true;
    }

    return !current.visible && this.tabId < current.tabId;
  }

  private elect() {
    if (this.disposed) {
      return;
    }

    if (!isVisible()) {
      this.releaseLeadership();
      return;
    }

    const timestamp = now();
    const current = this.readLeader();
    if (!this.shouldTakeLeadership(current, timestamp)) {
      this.setLeader(false);
      return;
    }

    const nextRecord: LeaderRecord = {
      focused: isFocused(),
      heartbeatAt: timestamp,
      tabId: this.tabId,
      visible: true,
    };

    if (!this.writeLeader(nextRecord)) {
      this.setLeader(true);
      return;
    }

    const confirmed = this.readLeader();
    const ownsLeadership = confirmed?.tabId === this.tabId;
    this.setLeader(ownsLeadership);
    if (ownsLeadership) {
      try {
        this.broadcastChannel?.postMessage({ tabId: this.tabId });
      } catch {
        // BroadcastChannel is only a notification path; localStorage remains authoritative.
      }
    }
  }

  private releaseLeadership() {
    this.removeLeader();
    this.setLeader(false);
  }

  private setLeader(isLeader: boolean) {
    if (this.isLeader === isLeader) {
      return;
    }

    this.isLeader = isLeader;
    this.onLeadershipChange(isLeader);
  }
}
