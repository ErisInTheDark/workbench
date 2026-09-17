/*
 * Exports:
 * - parseTranscriptAssetAddress: read canonical and retained transcript asset paths.
 * - createTranscriptAssetAddress: construct a canonical WB asset URL.
 */
export function parseTranscriptAssetAddress(value: string) {
  const match = /^\/(api|daemon)\/transcript-assets\/(?:codex\/)?([A-Za-z0-9_-]+)\/([a-f0-9]{64}\.(?:png|jpg|webp|gif))$/u.exec(value);
  if (!match) return null;
  return { surface: match[1]!, threadId: match[2]!, assetName: match[3]! };
}

export function createTranscriptAssetAddress(threadId: string, assetName: string): string {
  return `/api/transcript-assets/${encodeURIComponent(threadId)}/${encodeURIComponent(assetName)}`;
}
