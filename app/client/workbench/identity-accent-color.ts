/*
 * Keywords: identity, colour, hue, hash, theme.
 * Exports:
 * - IdentityAccentStyle: typed CSS variables for identity-coloured elements.
 * - getIdentityAccentHue: derive stable hue degrees from an identity and optional offset.
 */

import type { CSSProperties } from "react";

export type IdentityAccentStyle = CSSProperties & {
  "--identity-hue": number;
  "--hue-chroma"?: string;
};

function hashIdentity(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function getIdentityAccentHue(identity: string, hueOffsetDegrees = 0) {
  return (hashIdentity(identity) % 360 + hueOffsetDegrees) % 360;
}
