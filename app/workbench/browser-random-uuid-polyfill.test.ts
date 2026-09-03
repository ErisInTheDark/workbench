/* No production exports. Tests protect native UUID preservation and the secure Safari-compatible UUID v4 fallback. */
import assert from "node:assert/strict";
import test from "node:test";

import { installBrowserRandomUuidPolyfill } from "./browser-random-uuid-polyfill.ts";

function createCryptoSource(bytes: readonly number[]) {
  return {
    getRandomValues<T extends ArrayBufferView | null>(array: T) {
      assert.ok(array instanceof Uint8Array);
      array.set(bytes);
      return array;
    },
  } as Crypto;
}

test("the random UUID polyfill preserves the native browser implementation", () => {
  const nativeRandomUuid = () => "00000000-0000-4000-8000-000000000001" as `${string}-${string}-${string}-${string}-${string}`;
  const cryptoSource = Object.assign(createCryptoSource([]), { randomUUID: nativeRandomUuid });

  installBrowserRandomUuidPolyfill(cryptoSource);

  assert.equal(cryptoSource.randomUUID, nativeRandomUuid);
});

test("the random UUID polyfill creates a canonical UUID v4 from secure random bytes", () => {
  const cryptoSource = createCryptoSource([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  Reflect.deleteProperty(cryptoSource, "randomUUID");

  installBrowserRandomUuidPolyfill(cryptoSource);

  assert.equal(cryptoSource.randomUUID(), "00010203-0405-4607-8809-0a0b0c0d0e0f");
});
