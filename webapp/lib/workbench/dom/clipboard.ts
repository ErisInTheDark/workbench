/*
 * Exports:
 * - ClipboardImageDataUrl: pasted image file payload converted for browser-to-server/client attachment flows. Keywords: clipboard, image, data URL.
 * - readFileAsDataUrl: read a browser File as a data URL. Keywords: clipboard, file, image, data URL.
 * - readClipboardImageDataUrls: read image files from a clipboard data transfer. Keywords: clipboard, paste, image, data URL.
 * - writeTextToClipboard: safely write text to the browser clipboard. Keywords: clipboard, browser, copy, DOM.
 */

export interface ClipboardImageDataUrl {
  name: string;
  type: string;
  url: string;
}

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error("Unable to read the pasted image."));
    };
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Unable to read the pasted image."));
    };
    reader.readAsDataURL(file);
  });
}

export async function readClipboardImageDataUrls(items: DataTransferItemList): Promise<ClipboardImageDataUrl[]> {
  const imageFiles = Array.from(items)
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);

  return await Promise.all(imageFiles.map(async (file) => ({
    name: file.name,
    type: file.type,
    url: await readFileAsDataUrl(file),
  })));
}

export async function writeTextToClipboard(text: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
