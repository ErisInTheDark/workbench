/*
 * Exports:
 * - statsModelHues: a stable, visibly distinct hue for each model shown together.
 * - statsModelHueStyle: CSS variable that `bg-hue-[var(--model-hue)]` reads.
 */
import type { CSSProperties } from "react";

const GOLDEN_ANGLE = 137.508;
const MINIMUM_SEPARATION = 28;

function hashHue(key: string) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

function distance(left: number, right: number) {
  const difference = Math.abs(left - right) % 360;
  return Math.min(difference, 360 - difference);
}

/**
 * Pass every model in the window, not only the filtered ones, so filtering never repaints the rest.
 * Each model starts from its own hashed hue, so colours look random but stay put across ranges and filters.
 * Models are placed in sorted order and step along the golden angle away from hues already taken.
 */
export function statsModelHues(models: Iterable<string>) {
  const hues = new Map<string, number>();
  for (const key of [...new Set(models)].sort()) {
    let hue = hashHue(key);
    for (let attempt = 0; attempt < 12 && [...hues.values()].some((taken) => distance(taken, hue) < MINIMUM_SEPARATION); attempt += 1) {
      hue = (hue + GOLDEN_ANGLE) % 360;
    }
    hues.set(key, Math.round(hue));
  }
  return hues;
}

export function statsModelHueStyle(hue: number | undefined): CSSProperties | undefined {
  return hue === undefined ? undefined : { "--model-hue": hue } as CSSProperties;
}
