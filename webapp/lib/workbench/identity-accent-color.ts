/*
 * Exports:
 * - getIdentityAccentColor: derive one stable theme-aware OKLCH accent from an identity and optional hue offset. Keywords: identity, color, hue, hash, theme.
 */

function hashIdentity(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function getIdentityAccentColor(identity: string, chromaPercent = 90, hueOffsetDegrees = 0) {
  const hue = (hashIdentity(identity) % 360 + hueOffsetDegrees) % 360;
  return `oklch(var(--oklch-text-lightness) ${chromaPercent}% ${hue}deg)`;
}
