/*
 * Exports:
 * - ThreadTextPresentationField/ThreadTextPresentationKey/ThreadTextPresentationSource: exact source-qualified streaming text identity.
 * - default ThreadTextPresentationController: owns token-paced text presentation independent of delta shape, and exact-field subscriptions.
 */

import type { TranscriptTextField } from "workbench-shared/workbench/transcript/thread-transcript-stream";
export type ThreadTextPresentationField = TranscriptTextField;

export interface ThreadTextPresentationSource {
  kind: "json" | "sqlite";
  sourceKey: string;
}

export interface ThreadTextPresentationKey {
  field: ThreadTextPresentationField;
  index: number | null;
  itemId: string;
  source: ThreadTextPresentationSource;
  threadId: string;
  turnId: string;
}

interface FieldState {
  /** Reveal budget carried between frames, in characters. */
  budget: number;
  canonicalText: string;
  createdAt: number;
  displayedText: string;
  /** Created from an item's first text and not yet watched; it may still be revealed from empty. */
  fresh: boolean;
  lastFrameAt: number | null;
  listeners: Set<() => void>;
  pendingText: string;
  /** Current reveal speed in characters per millisecond. */
  rate: number;
}

type ScheduleFrame = (callback: (timestamp: number) => void) => () => void;

const MAX_FIELD_PENDING_CHARACTERS = 512 * 1024;
const MAX_PASSIVE_FIELDS = 512;
/** Deltas only move the target text; reveal speed is owned here so delta size and timing never show. */
const BASE_REVEAL_RATE = 0.12;
const CATCH_UP_LATENCY_MS = 1_000;
const RATE_EASE_MS = 300;
const MAX_FRAME_MS = 100;
/** Long tokens (urls, paths, unbroken code) cost at most this many characters so they never stall reveal. */
const MAX_TOKEN_COST = 8;
const FRESH_FIELD_WINDOW_MS = 1_000;
const REVEAL_TOKEN = /\s*\S+\s*/y;

function defaultScheduleFrame(callback: (timestamp: number) => void) {
  const frame = window.requestAnimationFrame(callback);
  return () => window.cancelAnimationFrame(frame);
}

function fieldKey(key: ThreadTextPresentationKey) {
  return [
    key.source.kind,
    key.source.sourceKey,
    key.threadId,
    key.turnId,
    key.itemId,
    key.field,
    key.index ?? "",
  ].join("\0");
}

function sourcePrefix(source: ThreadTextPresentationSource) {
  return `${source.kind}\0${source.sourceKey}\0`;
}

function tokenLength(text: string, from: number) {
  REVEAL_TOKEN.lastIndex = from;
  return REVEAL_TOKEN.exec(text)?.[0].length ?? text.length - from;
}

function settledState(canonicalText: string, now: number): FieldState {
  return {
    budget: 0,
    canonicalText,
    createdAt: now,
    displayedText: canonicalText,
    fresh: false,
    lastFrameAt: null,
    listeners: new Set(),
    pendingText: "",
    rate: BASE_REVEAL_RATE,
  };
}

export default class ThreadTextPresentationController {
  readonly #fields = new Map<string, FieldState>();
  readonly #now: () => number;
  readonly #reducedMotion: () => boolean;
  readonly #scheduleFrame: ScheduleFrame;
  #cancelFrame: (() => void) | null = null;
  #disposed = false;

  constructor({
    now = () => performance.now(),
    reducedMotion = () => typeof window !== "undefined"
      && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
    scheduleFrame = defaultScheduleFrame,
  }: {
    now?: () => number;
    reducedMotion?: () => boolean;
    scheduleFrame?: ScheduleFrame;
  } = {}) {
    this.#now = now;
    this.#reducedMotion = reducedMotion;
    this.#scheduleFrame = scheduleFrame;
  }

  acceptDelta({
    canonicalText,
    delta,
    key,
  }: {
    canonicalText: string;
    delta: string;
    key: ThreadTextPresentationKey;
  }) {
    if (this.#disposed || !delta) return;
    const identity = fieldKey(key);
    const current = this.#fields.get(identity);
    const now = this.#now();
    if (!current) {
      for (const [passiveIdentity, passiveState] of this.#fields) {
        if (this.#fields.size < MAX_PASSIVE_FIELDS) break;
        if (!passiveState.listeners.size) this.#fields.delete(passiveIdentity);
      }
      const state = settledState(canonicalText, now);
      if (canonicalText === delta && !this.#reducedMotion()) {
        state.displayedText = "";
        state.pendingText = canonicalText;
        state.fresh = true;
      }
      this.#fields.set(identity, state);
      return;
    }
    // Canonical text decides what is new, so a provider restating the whole field adds only its unseen tail.
    const appends = canonicalText.startsWith(current.canonicalText);
    const addition = canonicalText.slice(current.canonicalText.length);
    if (appends && !addition) return;
    if (!current.listeners.size) {
      if (current.fresh && appends && now - current.createdAt <= FRESH_FIELD_WINDOW_MS) {
        current.canonicalText = canonicalText;
        current.pendingText += addition;
        return;
      }
      Object.assign(current, settledState(canonicalText, now), { listeners: current.listeners });
      return;
    }
    if (!appends || !canonicalText.startsWith(current.displayedText) || this.#reducedMotion()) {
      this.#snap(identity, canonicalText);
      return;
    }

    current.canonicalText = canonicalText;
    current.pendingText += addition;
    if (current.pendingText.length > MAX_FIELD_PENDING_CHARACTERS) {
      this.#snap(identity, canonicalText);
      return;
    }
    this.#schedule();
  }

  complete(key: ThreadTextPresentationKey, canonicalText: string, { snap = false } = {}) {
    if (this.#disposed) return;
    const identity = fieldKey(key);
    const state = this.#fields.get(identity);
    if (!state) return;
    const targetChanged = state.canonicalText !== canonicalText;
    state.canonicalText = canonicalText;
    if (snap || targetChanged || !canonicalText.startsWith(state.displayedText)) {
      this.#snap(identity, canonicalText);
    }
  }

  getSnapshot(key: ThreadTextPresentationKey) {
    return this.#fields.get(fieldKey(key))?.displayedText ?? null;
  }

  hasSubscribers(key: ThreadTextPresentationKey) {
    return Boolean(this.#fields.get(fieldKey(key))?.listeners.size);
  }

  subscribe(key: ThreadTextPresentationKey, canonicalText: string, listener: () => void) {
    if (this.#disposed) return () => undefined;
    const identity = fieldKey(key);
    let state = this.#fields.get(identity);
    const now = this.#now();
    if (!state) {
      state = settledState(canonicalText, now);
      this.#fields.set(identity, state);
    } else if (state.fresh && now - state.createdAt > FRESH_FIELD_WINDOW_MS) {
      // Text that arrived while nobody watched is already there: show it whole, so only later text reveals.
      Object.assign(state, settledState(state.canonicalText, now), { listeners: state.listeners });
    } else if (
      !state.pendingText
      && state.canonicalText !== canonicalText
      && !state.canonicalText.startsWith(canonicalText)
    ) {
      Object.assign(state, settledState(canonicalText, this.#now()), { listeners: state.listeners });
    } else if (
      !state.canonicalText.startsWith(canonicalText)
      && !canonicalText.startsWith(state.displayedText)
    ) {
      Object.assign(state, settledState(canonicalText, this.#now()), { listeners: state.listeners });
    }
    state.fresh = false;
    state.listeners.add(listener);
    this.#schedule();
    const subscribed = state;
    return () => {
      subscribed.listeners.delete(listener);
      if (!subscribed.listeners.size) {
        this.#fields.delete(identity);
        this.#cancelFrameIfIdle();
      }
    };
  }

  resetSource(source: ThreadTextPresentationSource) {
    if (this.#disposed) return;
    const prefix = sourcePrefix(source);
    for (const [identity, state] of this.#fields) {
      if (!identity.startsWith(prefix)) continue;
      this.#fields.delete(identity);
      this.#notify(state);
    }
    this.#cancelFrameIfIdle();
  }

  clear() {
    if (this.#disposed) return;
    const states = [...this.#fields.values()];
    this.#fields.clear();
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    for (const state of states) this.#notify(state);
  }

  dispose() {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
  }

  #isRevealing(state: FieldState) {
    return Boolean(state.pendingText) && state.listeners.size > 0;
  }

  #schedule() {
    if (this.#cancelFrame || this.#disposed) return;
    if (![...this.#fields.values()].some((state) => this.#isRevealing(state))) return;
    this.#cancelFrame = this.#scheduleFrame((timestamp) => {
      this.#cancelFrame = null;
      this.#tick(timestamp);
    });
  }

  #tick(timestamp: number) {
    for (const [identity, state] of this.#fields) {
      if (!this.#isRevealing(state)) continue;
      const elapsed = state.lastFrameAt === null ? 16 : Math.min(MAX_FRAME_MS, Math.max(0, timestamp - state.lastFrameAt));
      state.lastFrameAt = timestamp;
      const target = Math.max(BASE_REVEAL_RATE, state.pendingText.length / CATCH_UP_LATENCY_MS);
      state.rate += (target - state.rate) * (1 - Math.exp(-elapsed / RATE_EASE_MS));
      state.budget += state.rate * elapsed;

      let revealLength = 0;
      while (revealLength < state.pendingText.length) {
        const length = tokenLength(state.pendingText, revealLength);
        const cost = Math.min(length, MAX_TOKEN_COST);
        if (state.budget < cost) break;
        state.budget -= cost;
        revealLength += length;
      }
      if (revealLength === 0) continue;

      const nextText = `${state.displayedText}${state.pendingText.slice(0, revealLength)}`;
      if (!state.canonicalText.startsWith(nextText)) {
        this.#snap(identity, state.canonicalText);
        continue;
      }
      state.displayedText = nextText;
      state.pendingText = state.pendingText.slice(revealLength);
      if (!state.pendingText) {
        state.budget = 0;
        state.lastFrameAt = null;
        state.rate = BASE_REVEAL_RATE;
      }
      this.#notify(state);
    }
    this.#schedule();
  }

  #snap(identity: string, canonicalText: string) {
    const state = this.#fields.get(identity);
    if (!state) return;
    const changed = state.displayedText !== canonicalText;
    Object.assign(state, settledState(canonicalText, state.createdAt), { listeners: state.listeners });
    if (changed) this.#notify(state);
    this.#cancelFrameIfIdle();
  }

  #notify(state: FieldState) {
    for (const listener of state.listeners) listener();
  }

  #cancelFrameIfIdle() {
    if ([...this.#fields.values()].some((state) => this.#isRevealing(state))) return;
    this.#cancelFrame?.();
    this.#cancelFrame = null;
  }
}
