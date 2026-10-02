/*
 * No production exports. Tests WB_STORES tokenising and reference matching.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { expandStoreCommand, findStoreReferences, parseStoreDefinitions } from "./store-definitions.mjs";

test("named stores split on semicolons only outside quotes", () => {
  const stores = parseStoreDefinitions(`wb: wb store get {key}; vault: vault get "a;b c" {key};other:thing {key}`);
  assert.deepEqual(Object.fromEntries(stores), {
    wb: ["wb", "store", "get", "{key}"],
    vault: ["vault", "get", "a;b c", "{key}"],
    other: ["thing", "{key}"],
  });
});

test("quotes escape only quotes and backslashes, keeping other backslashes literal", () => {
  const stores = parseStoreDefinitions(String.raw`s: C:\tools\cli.exe "say \"hi\" \\ \n" ""`);
  assert.deepEqual(stores.get("s"), [String.raw`C:\tools\cli.exe`, String.raw`say "hi" \ \n`, ""]);
});

test("keys substitute into arguments without becoming extra arguments or the executable", () => {
  const [template] = parseStoreDefinitions("s: cli --name={key} {key}").values();
  assert.deepEqual(expandStoreCommand(template!, `x" ; rm -rf / {key}`), [
    "cli", `--name=x" ; rm -rf / {key}`, `x" ; rm -rf / {key}`,
  ]);
  assert.throws(() => parseStoreDefinitions("s: {key} get"), /executable/);
});

test("malformed definitions are rejected", () => {
  assert.throws(() => parseStoreDefinitions(`s: cli "open`), /unterminated/);
  assert.throws(() => parseStoreDefinitions("cli get {key}"), /store name/);
  assert.throws(() => parseStoreDefinitions("s:"), /no command/);
  assert.throws(() => parseStoreDefinitions("s: a; s: b"), /more than once/);
});

test("references are found with exact ranges and ignore other dollar syntax", () => {
  const value = "Bearer ${wb:token} ${PLAIN} ${vault:a/b.c}";
  assert.deepEqual(findStoreReferences(value).map(({ store, key, start, end }) => ({ store, key, text: value.slice(start, end) })), [
    { store: "wb", key: "token", text: "${wb:token}" },
    { store: "vault", key: "a/b.c", text: "${vault:a/b.c}" },
  ]);
});
