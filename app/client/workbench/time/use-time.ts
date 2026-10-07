/*
 * Exports:
 * - TimeSourcePorts: clock and timer ports a time source runs on.
 * - createTimeSource: shared tickers keyed by interval; each runs only while it has subscribers.
 * - useTime: the current time in ms, refreshed every `intervalMs` by a ticker shared with every caller on that interval.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface TimeSourcePorts {
  clearInterval(handle: number): void;
  now(): number;
  setInterval(tick: () => void, intervalMs: number): number;
}

interface Ticker {
  handle: number;
  listeners: Set<() => void>;
  now: number;
}

export function createTimeSource(ports: TimeSourcePorts) {
  const tickers = new Map<number, Ticker>();
  // Snapshots must stay stable between reads until a tick, including before anyone subscribes.
  const idle = new Map<number, number>();
  return {
    read(intervalMs: number) {
      const ticking = tickers.get(intervalMs);
      if (ticking) return ticking.now;
      const cached = idle.get(intervalMs);
      if (cached !== undefined) return cached;
      const now = ports.now();
      idle.set(intervalMs, now);
      return now;
    },
    subscribe(intervalMs: number, listener: () => void) {
      let ticker = tickers.get(intervalMs);
      if (!ticker) {
        const created: Ticker = { handle: 0, listeners: new Set(), now: ports.now() };
        created.handle = ports.setInterval(() => {
          created.now = ports.now();
          for (const notify of [...created.listeners]) notify();
        }, intervalMs);
        tickers.set(intervalMs, created);
        idle.delete(intervalMs);
        ticker = created;
      }
      ticker.listeners.add(listener);
      const owned = ticker;
      return () => {
        owned.listeners.delete(listener);
        if (owned.listeners.size || tickers.get(intervalMs) !== owned) return;
        ports.clearInterval(owned.handle);
        tickers.delete(intervalMs);
      };
    },
  };
}

const browserTime = createTimeSource({
  clearInterval: (handle) => window.clearInterval(handle),
  now: () => Date.now(),
  setInterval: (tick, intervalMs) => window.setInterval(tick, intervalMs),
});

export function useTime(intervalMs: number) {
  const subscribe = useCallback((listener: () => void) => browserTime.subscribe(intervalMs, listener), [intervalMs]);
  const read = useCallback(() => browserTime.read(intervalMs), [intervalMs]);
  return useSyncExternalStore(subscribe, read, read);
}
