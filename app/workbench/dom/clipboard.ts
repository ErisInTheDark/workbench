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

function writeTextWithLegacyClipboard(text: string) {
  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") {
    return false;
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = typeof window !== "undefined" && typeof window.getSelection === "function"
    ? window.getSelection()
    : null;
  const selectedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : [];
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);

  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      selectedRanges.forEach((range) => selection.addRange(range));
    }
  }
}

export async function writeTextToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // The legacy path can still work when the modern API is blocked by browser policy.
    }
  }

  return writeTextWithLegacyClipboard(text);
}
