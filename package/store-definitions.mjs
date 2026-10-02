/*
 * Exports:
 * - DEFAULT_STORE_DEFINITIONS: fallback WB_STORES text used when a file defines none.
 * - parseStoreDefinitions: tokenise WB_STORES text into named argv templates without shell semantics.
 * - expandStoreCommand: substitute one key into a template's arguments after tokenisation.
 * - findStoreReferences: list `${store:key}` references in one value.
 */

export const DEFAULT_STORE_DEFINITIONS = "wb: wb store get {key}";

const STORE_NAME = /^[A-Za-z0-9_-]+$/u;
const REFERENCE = /\$\{([A-Za-z0-9_-]+):([^}\r\n]+)\}/gu;

function tokenise(text) {
  const definitions = [];
  let tokens = [];
  let token = "";
  let started = false;
  let quoted = false;
  let quotedToken = false;
  const endToken = () => {
    if (started) tokens.push({ text: token, quoted: quotedToken });
    token = "";
    started = false;
    quotedToken = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "\\" && (text[index + 1] === "\"" || text[index + 1] === "\\")) {
        token += text[index + 1];
        index += 1;
      } else if (character === "\"") {
        quoted = false;
      } else {
        token += character;
      }
      continue;
    }
    if (character === "\"") {
      quoted = true;
      started = true;
      quotedToken = true;
    } else if (character === ";") {
      endToken();
      definitions.push(tokens);
      tokens = [];
    } else if (/\s/u.test(character)) {
      endToken();
    } else {
      token += character;
      started = true;
    }
  }
  if (quoted) throw new Error("WB_STORES has an unterminated double quote.");
  endToken();
  definitions.push(tokens);
  return definitions.filter(definition => definition.length);
}

export function parseStoreDefinitions(text) {
  const stores = new Map();
  for (const tokens of tokenise(text)) {
    const [first, ...rest] = tokens;
    const separator = first.quoted ? -1 : first.text.indexOf(":");
    const name = separator > 0 ? first.text.slice(0, separator) : "";
    if (!STORE_NAME.test(name)) throw new Error("Each WB_STORES entry must start with a store name followed by a colon.");
    if (stores.has(name)) throw new Error(`WB_STORES defines the ${name} store more than once.`);
    const remainder = first.text.slice(separator + 1);
    const argv = [...(remainder ? [remainder] : []), ...rest.map(token => token.text)];
    if (!argv.length) throw new Error(`WB_STORES gives the ${name} store no command.`);
    if (argv[0].includes("{key}")) throw new Error(`WB_STORES cannot place {key} in the ${name} store's executable.`);
    stores.set(name, argv);
  }
  return stores;
}

export function expandStoreCommand(template, key) {
  const [executable, ...args] = template;
  return [executable, ...args.map(arg => arg.replaceAll("{key}", key))];
}

export function findStoreReferences(value) {
  return Array.from(value.matchAll(REFERENCE), match => ({
    end: match.index + match[0].length,
    key: match[2],
    start: match.index,
    store: match[1],
    text: match[0],
  }));
}
