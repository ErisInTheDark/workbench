/*
 * Exports:
 * - ComponentImageFetch: fetch one public image's type and bytes.
 * - fetchComponentImages: public https images as data URLs, null for any that fail, are not png/jpeg/gif/webp, or exceed
 *   the caps, so a browser drawing a component never loads them remotely.
 * - inlineComponentImages: replace a tree's public https images with those data URLs, dropping the ones that are null.
 */
import {
  inlineThreadComponentImages, listThreadComponentImageUrls, type ThreadComponentNode,
} from "workbench-shared/workbench/thread/thread-component-tree";

export type ComponentImageFetch = (url: string, maxBytes: number, signal?: AbortSignal) => Promise<{ contentType: string; bytes: Buffer }>;

const MAX_IMAGES = 32;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function inlineComponentImages(
  tree: ThreadComponentNode, fetchImage: ComponentImageFetch, signal?: AbortSignal,
): Promise<ThreadComponentNode> {
  return inlineThreadComponentImages(tree, await fetchComponentImages(listThreadComponentImageUrls(tree), fetchImage, signal));
}

export async function fetchComponentImages(
  urls: readonly string[], fetchImage: ComponentImageFetch, signal?: AbortSignal,
): Promise<Map<string, string | null>> {
  const fetched = await Promise.all(urls.slice(0, MAX_IMAGES).map(async url => {
    try {
      const image = await fetchImage(url, MAX_IMAGE_BYTES, signal);
      const type = image.contentType.split(";")[0]!.trim().toLowerCase();
      return IMAGE_TYPES.has(type) && image.bytes.byteLength <= MAX_IMAGE_BYTES ? { url, type, bytes: image.bytes } : null;
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }));
  const images = new Map<string, string | null>(urls.map(url => [url, null]));
  let total = 0;
  for (const image of fetched) {
    if (!image || total + image.bytes.byteLength > MAX_TOTAL_BYTES) continue;
    total += image.bytes.byteLength;
    images.set(image.url, `data:${image.type};base64,${image.bytes.toString("base64")}`);
  }
  return images;
}
