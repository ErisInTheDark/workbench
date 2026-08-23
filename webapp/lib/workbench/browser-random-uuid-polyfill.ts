/*
 * Exports:
 * - installBrowserRandomUuidPolyfill: install a secure UUID v4 implementation when the browser omits crypto.randomUUID. Keywords: browser, crypto, UUID, Safari, polyfill.
 */

type BrowserCrypto = Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;

function createRandomUuid(cryptoSource: Pick<Crypto, "getRandomValues">) {
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function installBrowserRandomUuidPolyfill(cryptoSource: BrowserCrypto | undefined = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === "function") return;
  if (typeof cryptoSource?.getRandomValues !== "function") {
    throw new Error("This browser does not provide secure random values for UUID generation.");
  }

  Object.defineProperty(cryptoSource, "randomUUID", {
    configurable: true,
    enumerable: false,
    value: () => createRandomUuid(cryptoSource),
    writable: true,
  });
}
